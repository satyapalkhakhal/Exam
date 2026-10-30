// src/components/ui/confirm-dialog.tsx
// Generic confirm-before-acting dialog. `description` is a ReactNode so callers
// can fold a backend error message into it and keep the dialog open on failure
// instead of losing the message to a closed modal.

import { useEffect, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  isPending: boolean;
  variant?: ButtonProps['variant'];
  /**
   * When set, the confirm button stays disabled until this exact word is typed.
   * Reserved for actions whose blast radius is the whole company (e.g. turning
   * IP enforcement on) — a reflexive click should not be enough.
   */
  confirmPhrase?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  onConfirm,
  isPending,
  variant = 'destructive',
  confirmPhrase,
}: ConfirmDialogProps) {
  const [typedPhrase, setTypedPhrase] = useState('');

  // Callers that keep the dialog mounted across open/close would otherwise
  // reopen with the phrase already satisfied from last time.
  useEffect(() => {
    if (!open) setTypedPhrase('');
  }, [open]);

  const phraseSatisfied = confirmPhrase === undefined || typedPhrase.trim() === confirmPhrase;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let Escape/overlay dismiss the dialog mid-request.
        if (isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {/* asChild + div: description can carry block-level nodes (error text),
              which would be invalid nested inside Radix's default <p>. */}
          <DialogDescription asChild>
            <div className="space-y-2">{description}</div>
          </DialogDescription>
        </DialogHeader>

        {confirmPhrase !== undefined && (
          <div className="px-6 pb-4 space-y-1.5">
            <Label htmlFor="confirm-dialog-phrase">
              Type <span className="font-mono font-semibold text-foreground">{confirmPhrase}</span>{' '}
              to confirm
            </Label>
            <Input
              id="confirm-dialog-phrase"
              value={typedPhrase}
              onChange={(e) => setTypedPhrase(e.target.value)}
              disabled={isPending}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={variant}
            onClick={onConfirm}
            loading={isPending}
            disabled={!phraseSatisfied}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
