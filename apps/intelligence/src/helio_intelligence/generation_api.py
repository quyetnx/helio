"""HTTP surface for NL→segment and NL→journey generation.

Both return a draft the dashboard can review and save through the normal
TypeScript APIs (which re-validate). Generation itself is schema-driven;
journey generation is grounded in the caller's own templates.
"""

from __future__ import annotations

import base64
import binascii
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .agent import OrgScope
from .agent.nl_email import NlEmailGenerator
from .agent.nl_journey import NlJourneyGenerator
from .agent.nl_segment import NlSegmentGenerator
from .data import OrgRepository
from .llm import ImagePart


class SegmentRequest(BaseModel):
    organization_id: str = Field(min_length=1, max_length=64)
    workspace_id: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1, max_length=2000)


class SegmentResponse(BaseModel):
    name: str
    rule: dict[str, Any]


class JourneyRequest(BaseModel):
    organization_id: str = Field(min_length=1, max_length=64)
    workspace_id: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1, max_length=2000)


class JourneyResponse(BaseModel):
    name: str
    definition: dict[str, Any]


class EmailRequest(BaseModel):
    organization_id: str = Field(min_length=1, max_length=64)
    workspace_id: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1, max_length=2000)


# Anthropic caps an image at 5 MB; base64 inflates by 4/3.
_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
# PNG / JPEG / GIF / WebP magic numbers: the declared type must match the bytes.
_SIGNATURES = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/webp": (b"RIFF",),
}


class EmailFromImageRequest(BaseModel):
    organization_id: str = Field(min_length=1, max_length=64)
    workspace_id: str = Field(min_length=1, max_length=64)
    image_base64: str = Field(min_length=16, max_length=_MAX_IMAGE_BYTES * 4 // 3 + 16)
    media_type: str = Field(max_length=40)
    prompt: str = Field(default="", max_length=1000)


def _validated_image(request: EmailFromImageRequest) -> ImagePart:
    if request.media_type not in _IMAGE_TYPES:
        raise HTTPException(status_code=422, detail="the image must be PNG, JPEG, WebP or GIF")
    try:
        raw = base64.b64decode(request.image_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail="the image is not valid base64") from error
    if len(raw) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=422, detail="the image is larger than 5 MB")
    if not raw.startswith(_SIGNATURES[request.media_type]):
        raise HTTPException(status_code=422, detail="the file does not match its image type")
    return ImagePart(media_type=request.media_type, data=request.image_base64)


class EmailResponse(BaseModel):
    name: str
    subject: str
    document: dict[str, Any]


def get_segment_generator() -> NlSegmentGenerator:
    raise HTTPException(
        status_code=503, detail="generation is not configured (set INTEL_LLM_API_KEY)"
    )


def get_journey_generator() -> NlJourneyGenerator:
    raise HTTPException(
        status_code=503, detail="generation is not configured (set INTEL_LLM_API_KEY)"
    )


def get_email_generator() -> NlEmailGenerator:
    raise HTTPException(
        status_code=503, detail="generation is not configured (set INTEL_LLM_API_KEY)"
    )


def get_repository() -> OrgRepository:
    raise HTTPException(
        status_code=503, detail="database is not configured (set INTEL_DATABASE_URL)"
    )


def create_generation_router() -> APIRouter:
    router = APIRouter(prefix="/v1/copilot", tags=["generation"])

    @router.post("/segment", response_model=SegmentResponse)
    async def nl_to_segment(
        request: SegmentRequest,
        generator: Annotated[NlSegmentGenerator, Depends(get_segment_generator)],
    ) -> SegmentResponse:
        try:
            result = await generator.generate(request.prompt)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return SegmentResponse(name=result.name, rule=result.rule)

    @router.post("/journey", response_model=JourneyResponse)
    async def nl_to_journey(
        request: JourneyRequest,
        generator: Annotated[NlJourneyGenerator, Depends(get_journey_generator)],
        repository: Annotated[OrgRepository, Depends(get_repository)],
    ) -> JourneyResponse:
        scope = OrgScope(request.organization_id, request.workspace_id)
        templates = await repository.template_options(scope.organization_id, scope.workspace_id)
        try:
            result = await generator.generate(request.prompt, templates)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return JourneyResponse(name=result.name, definition=result.definition)

    @router.post("/email", response_model=EmailResponse)
    async def nl_to_email(
        request: EmailRequest,
        generator: Annotated[NlEmailGenerator, Depends(get_email_generator)],
        repository: Annotated[OrgRepository, Depends(get_repository)],
    ) -> EmailResponse:
        scope = OrgScope(request.organization_id, request.workspace_id)
        templates = await repository.list_email_templates(scope.organization_id, scope.workspace_id)
        voice = [str(t["subject"]) for t in templates if t.get("subject")]
        try:
            result = await generator.generate(request.prompt, voice)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return EmailResponse(name=result.name, subject=result.subject, document=result.document)

    @router.post("/email-from-image", response_model=EmailResponse)
    async def image_to_email(
        request: EmailFromImageRequest,
        generator: Annotated[NlEmailGenerator, Depends(get_email_generator)],
        repository: Annotated[OrgRepository, Depends(get_repository)],
    ) -> EmailResponse:
        image = _validated_image(request)
        scope = OrgScope(request.organization_id, request.workspace_id)
        templates = await repository.list_email_templates(scope.organization_id, scope.workspace_id)
        voice = [str(t["subject"]) for t in templates if t.get("subject")]
        try:
            result = await generator.generate_from_image(image, request.prompt, voice)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return EmailResponse(name=result.name, subject=result.subject, document=result.document)

    return router
