import { API_BASE } from '../lib/api';
import { fmtRelative } from '../lib/format';
import type { DemoState, LocalizationEvent } from '../types';
import { Button, Chip } from './ui';

function eventTone(t: LocalizationEvent['event_type']) {
  switch (t) {
    case 'vendor_delivery':
      return 'accent' as const;
    case 'source_revision':
      return 'warning' as const;
    case 'approved_version_ingested':
      return 'ready' as const;
    case 'release_gate_run':
      return 'gemini' as const;
    default:
      return 'muted' as const;
  }
}

function eventLabel(t: LocalizationEvent['event_type']) {
  switch (t) {
    case 'vendor_delivery':
      return 'Vendor delivery';
    case 'source_revision':
      return 'Source revision';
    case 'script_locked':
      return 'Script locked';
    case 'release_scheduled':
      return 'Release scheduled';
    case 'release_gate_run':
      return 'Release gate run';
    case 'approved_version_ingested':
      return 'Approved version ingested';
    default:
      return t;
  }
}

function EventRow({ ev, now, primary = false }: { ev: LocalizationEvent; now: number; primary?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Chip tone={eventTone(ev.event_type)} className="w-[132px] shrink-0 justify-center">
        {eventLabel(ev.event_type)}
        {ev.target_version !== null ? ` v${ev.target_version}` : ''}
        {ev.event_type === 'source_revision' ? ` ${ev.source_revision}` : ''}
      </Chip>
      <span className={`min-w-0 truncate ${primary ? 'text-[13.5px] font-semibold text-text' : 'text-[13px] text-text/90'}`} title={ev.summary}>
        {ev.summary}
      </span>
      <span className="ll-tnum shrink-0 text-[11.5px] text-muted" title={ev.actor}>
        {ev.actor ? `${ev.actor} · ` : ''}
        {fmtRelative(ev.occurred_at, now)}
      </span>
    </div>
  );
}

export function IncomingEventCard({
  state,
  onRun,
  running,
  starting,
  disabled,
}: {
  state: DemoState;
  onRun: () => void;
  running: boolean;
  starting: boolean;
  disabled: boolean;
}) {
  const now = Date.parse(state.now) || Date.now();
  const incoming = state.incoming_event;
  const revision = state.recent_events.find((e) => e.event_type === 'source_revision' && e.source_revision === state.title.latest_source_revision);
  return (
    <section className="ll-card flex items-center gap-4 px-4 py-2" aria-label="Incoming event">
      <div className="flex w-[92px] shrink-0 flex-col text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
        <span>Incoming</span>
        <span>event</span>
        <span className="ll-mono mt-0.5 normal-case tracking-normal text-muted/80">src {state.title.latest_source_revision} · {state.title.runtime_min} min</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <EventRow ev={incoming} now={now} primary />
        {revision && <EventRow ev={revision} now={now} />}
        <a
          className="ll-mono w-fit text-[11.5px] text-accent hover:underline"
          href={`${API_BASE}${state.delivery.file.url}`}
          download={state.delivery.file.filename}
          title="Download the subtitle file exactly as the vendor delivered it"
        >
          ⤓ {state.delivery.file.filename} · {state.delivery.file.cue_count} cues
        </a>
      </div>
      <Button variant="primary" size="lg" onClick={onRun} disabled={disabled || running} loading={starting} className="min-w-[210px]">
        {running ? 'Release gate running…' : 'Run release gate'}
      </Button>
    </section>
  );
}
