'use client';

import type { ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

type IconProps = { className?: string };
type IconComponent = (props: IconProps) => ReactNode;

const MAX_QUICK_REPLIES = 3;
const DEFAULT_QUICK_REPLIES = ['Looks good', 'Continue', 'Tell me more'];

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function IconSvg({ className, children }: IconProps & { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={className ?? 'h-6 w-6'} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}
function CloseIcon({ className }: IconProps) { return <IconSvg className={className}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></IconSvg>; }
function MoonIcon({ className }: IconProps) { return <IconSvg className={className}><path d="M12 3a9 9 0 1 0 9 9 6.5 6.5 0 0 1-9-9z" /></IconSvg>; }
function SunIcon({ className }: IconProps) { return <IconSvg className={className}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2" /><path d="m4.93 4.93 1.41 1.41m11.32 11.32 1.41 1.41m-12.73 0-1.41 1.41M19.07 4.93l-1.41 1.41" /></IconSvg>; }
function SystemIcon({ className }: IconProps) { return <IconSvg className={className}><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M9 20h6M12 16v4" /></IconSvg>; }

function ThemeSettings({ theme, onChange }: { theme: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  const options: Array<{ value: ThemePreference; label: string; Icon: IconComponent }> = [
    { value: 'dark', label: 'Dark', Icon: MoonIcon }, { value: 'light', label: 'Light', Icon: SunIcon }, { value: 'system', label: 'System', Icon: SystemIcon },
  ];
  return <section className="rounded-3xl border border-neutral-200 bg-white p-3 text-sm" aria-label="Theme settings">
    <div className="mb-2 px-1 text-xs font-medium text-neutral-500">Theme</div>
    <div className="grid grid-cols-3 gap-1">{options.map(({ value, label, Icon }) => <button key={value} type="button" onClick={() => onChange(value)} className={cx('rounded-2xl px-2 py-2 text-xs font-semibold transition', theme === value ? 'bg-neutral-950 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200')} aria-pressed={theme === value} aria-label={`${label} theme`} title={`${label} theme`}><Icon className="mx-auto h-5 w-5" /><span className="mt-1 block">{label}</span></button>)}</div>
  </section>;
}

function QuickReplySettings({ quickReplies, enabled, onChange, onEnabledChange }: { quickReplies: string[]; enabled: boolean; onChange: (values: string[]) => void; onEnabledChange: (enabled: boolean) => void }) {
  return <section className="rounded-3xl border border-neutral-200 bg-white p-3 text-sm" aria-label="Quick reply settings">
    <div className="mb-2 flex items-center justify-between gap-3 px-1"><div><div className="text-xs font-medium text-neutral-500">Quick replies</div><div className="mt-0.5 text-[11px] leading-snug text-neutral-400">Show reusable replies above the composer.</div></div><button type="button" onClick={() => onChange(DEFAULT_QUICK_REPLIES)} className="rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-semibold text-neutral-500 hover:bg-neutral-200">Reset</button></div>
    <button type="button" onClick={() => onEnabledChange(!enabled)} className="mb-3 flex w-full items-center justify-between gap-3 rounded-2xl bg-neutral-100 px-3 py-2 text-left transition hover:bg-neutral-200/70" aria-pressed={enabled}><span><span className="block text-xs font-semibold text-neutral-700">Enable quick replies</span><span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">Shows reply chips and enables 1–3 then Tab autocomplete.</span></span><span className={cx('relative h-6 w-10 shrink-0 rounded-full transition', enabled ? 'bg-neutral-950' : 'bg-neutral-300')} aria-hidden="true"><span className={cx('absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition', enabled ? 'left-5' : 'left-1')} /></span></button>
    <div className="space-y-2">{Array.from({ length: MAX_QUICK_REPLIES }).map((_, index) => <label key={index} className={cx('flex items-center gap-2 rounded-2xl bg-neutral-100 px-3 py-2 focus-within:bg-neutral-200/70', !enabled && 'opacity-60')}><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-neutral-500">{index + 1}</span><input value={quickReplies[index] || ''} onChange={(event) => { const next = [...quickReplies]; next[index] = event.target.value.replace(/[\r\n\t]+/g, ' ').slice(0, 80); onChange(next.slice(0, MAX_QUICK_REPLIES)); }} placeholder={`Reply ${index + 1}`} disabled={!enabled} className="min-w-0 flex-1 bg-transparent text-sm font-medium text-neutral-950 outline-none placeholder:text-neutral-400" /></label>)}</div>
  </section>;
}

export function SidebarSettingsPanel({ theme, onThemeChange, quickReplies, quickRepliesEnabled, onQuickRepliesChange, onQuickRepliesEnabledChange, onClose }: { theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void; quickReplies: string[]; quickRepliesEnabled: boolean; onQuickRepliesChange: (values: string[]) => void; onQuickRepliesEnabledChange: (enabled: boolean) => void; onClose: () => void }) {
  return <section className="space-y-3" aria-label="Settings panel"><div className="flex items-center justify-between px-1 pt-1"><h2 className="text-xl font-semibold tracking-tight text-neutral-950">Settings</h2><button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100" aria-label="Close settings" title="Close settings"><CloseIcon className="h-5 w-5" /></button></div><ThemeSettings theme={theme} onChange={onThemeChange} /><QuickReplySettings quickReplies={quickReplies} enabled={quickRepliesEnabled} onChange={onQuickRepliesChange} onEnabledChange={onQuickRepliesEnabledChange} /></section>;
}
