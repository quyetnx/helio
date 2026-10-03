'use client';

import type { EmailBlock, EmailDocument } from '@helio/core';
import { Button } from '@helio/ui/components/button';
import { Input } from '@helio/ui/components/input';
import { Label } from '@helio/ui/components/label';
import { useMutation } from '@tanstack/react-query';
import { ImagePlus, Sparkles, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
type AcceptedType = (typeof ACCEPTED)[number];
/** Mirrors the intelligence service's cap (Anthropic limits images to 5 MB). */
const MAX_BYTES = 5 * 1024 * 1024;

export interface ImageDraft {
  name: string;
  subject: string;
  blocks: EmailBlock[];
}

interface PickedImage {
  previewUrl: string;
  base64: string;
  mediaType: AcceptedType;
  fileName: string;
}

function isAccepted(type: string): type is AcceptedType {
  return (ACCEPTED as readonly string[]).includes(type);
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      // "data:<type>;base64,<payload>" → the payload only.
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * "Create from image": drop, pick or paste a screenshot/mockup and the AI
 * copilot rebuilds it as editable blocks. The result only fills the editor —
 * nothing is saved until the user reviews it and presses Create.
 */
export function ImageToTemplate({
  workspaceId,
  onDraft,
}: {
  workspaceId: string;
  onDraft: (draft: ImageDraft) => void;
}) {
  const t = useTranslations('emails.fromImage');
  const trpc = useTRPC();
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const [hint, setHint] = useState('');
  const [dragging, setDragging] = useState(false);
  const draftFromImage = useMutation(trpc.copilot.draftEmailFromImage.mutationOptions());

  async function pick(file: File | undefined) {
    if (!file) return;
    if (!isAccepted(file.type)) {
      toast.error(t('badType'));
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error(t('tooLarge'));
      return;
    }
    try {
      const base64 = await readAsBase64(file);
      if (picked) URL.revokeObjectURL(picked.previewUrl);
      setPicked({
        previewUrl: URL.createObjectURL(file),
        base64,
        mediaType: file.type,
        fileName: file.name || t('pastedImage'),
      });
    } catch {
      toast.error(t('readError'));
    }
  }

  function clear() {
    if (picked) URL.revokeObjectURL(picked.previewUrl);
    setPicked(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function onGenerate() {
    if (!picked) return;
    try {
      const result = await draftFromImage.mutateAsync({
        workspaceId,
        imageBase64: picked.base64,
        mediaType: picked.mediaType,
        prompt: hint.trim(),
      });
      onDraft({
        name: result.name,
        subject: result.subject,
        blocks: (result.document as EmailDocument).blocks,
      });
      toast.success(t('done'));
      clear();
      setHint('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error'));
    }
  }

  return (
    <div
      data-testid="image-to-template"
      className={`grid gap-3 rounded-lg border border-dashed p-4 ${dragging ? 'bg-muted' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void pick(event.dataTransfer.files[0]);
      }}
      onPaste={(event) => {
        const file = Array.from(event.clipboardData.files).find((f) => isAccepted(f.type));
        if (file) {
          event.preventDefault();
          void pick(file);
        }
      }}
    >
      <div className="grid gap-1">
        <p className="text-sm font-medium">{t('title')}</p>
        <p className="text-muted-foreground text-sm">{t('hint')}</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(',')}
        className="sr-only"
        data-testid="image-to-template-input"
        aria-label={t('choose')}
        onChange={(event) => void pick(event.target.files?.[0])}
      />

      {picked ? (
        <div className="flex flex-wrap items-start gap-3">
          {/* A local blob preview of the user's own file; next/image adds nothing. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={picked.previewUrl}
            alt={t('previewAlt', { name: picked.fileName })}
            className="max-h-40 rounded-md border object-contain"
          />
          <div className="grid min-w-64 flex-1 gap-2">
            <Label htmlFor="image-to-template-hint">{t('guidance')}</Label>
            <Input
              id="image-to-template-hint"
              value={hint}
              onChange={(event) => setHint(event.target.value)}
              maxLength={1000}
              placeholder={t('guidancePlaceholder')}
            />
            <div className="flex gap-2">
              <Button onClick={onGenerate} disabled={draftFromImage.isPending}>
                <Sparkles aria-hidden /> {draftFromImage.isPending ? t('working') : t('generate')}
              </Button>
              <Button variant="ghost" onClick={clear} disabled={draftFromImage.isPending}>
                <X aria-hidden /> {t('remove')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
            <ImagePlus aria-hidden /> {t('choose')}
          </Button>
        </div>
      )}
      <p className="text-muted-foreground text-xs">{t('replaces')}</p>
    </div>
  );
}
