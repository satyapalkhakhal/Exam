// src/components/admin/NextRoundFields.tsx
// Why: next-round details for the Shortlisted email, shared by the template page (preview
// only) and the Send dialog. Dates are typed in IST (see lib/istTime).

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { nextRoundLinkError, type NextRoundForm } from '@/lib/emailTemplates';

export function NextRoundFields({ idPrefix, value, onChange }: { idPrefix: string; value: NextRoundForm; onChange: (v: NextRoundForm) => void }) {
  const set = (k: keyof NextRoundForm) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium">Next round (optional)</legend>
      <div className="space-y-1.5"><Label htmlFor={id('name')}>Round name</Label><Input id={id('name')} maxLength={120} value={value.name} onChange={set('name')} /></div>
      <div className="space-y-1.5"><Label htmlFor={id('mode')}>Mode</Label><Input id={id('mode')} maxLength={120} placeholder="e.g. Video call" value={value.mode} onChange={set('mode')} /></div>
      <div className="space-y-1.5"><Label htmlFor={id('at')}>Date and time (IST)</Label><Input id={id('at')} type="datetime-local" value={value.scheduledAt} onChange={set('scheduledAt')} /></div>
      <div className="space-y-1.5"><Label htmlFor={id('by')}>Confirm by (IST)</Label><Input id={id('by')} type="datetime-local" value={value.confirmBy} onChange={set('confirmBy')} /></div>
      <div className="space-y-1.5 sm:col-span-2"><Label htmlFor={id('venue')}>Venue</Label><Input id={id('venue')} maxLength={300} value={value.venue} onChange={set('venue')} /></div>
      <div className="space-y-1.5"><Label htmlFor={id('link')}>Link (https)</Label><Input id={id('link')} type="url" maxLength={500} value={value.link} error={nextRoundLinkError(value.link) ?? undefined} onChange={set('link')} /></div>
      <div className="space-y-1.5"><Label htmlFor={id('label')}>Link label</Label><Input id={id('label')} maxLength={60} value={value.linkLabel} onChange={set('linkLabel')} /></div>
      <div className="space-y-1.5 sm:col-span-2"><Label htmlFor={id('ins')}>Instructions</Label><Textarea id={id('ins')} rows={3} maxLength={2000} value={value.instructions} onChange={set('instructions')} /></div>
    </fieldset>
  );
}
