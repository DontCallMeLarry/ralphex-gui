import { useEffect, useState } from 'react';
import { age, api, type Checklist, type SpecimenView } from '../api.ts';
import { SproutAvatar } from '../avatar.tsx';
import { Overlay } from './Overlay.tsx';

const CHECK_LABELS: Array<{ key: keyof Checklist; label: string }> = [
  { key: 'sandbox', label: 'Sandbox' },
  { key: 'qa', label: 'QA' },
  { key: 'production', label: 'Production' },
];

/** The pressed-leaf scrapbook: pruned specimens, characters intact (FR-7.5). */
export function Archive({ onClose }: { onClose: () => void }) {
  const [specimens, setSpecimens] = useState<SpecimenView[] | null>(null);

  useEffect(() => {
    api.archive().then((r) => setSpecimens(r.specimens));
  }, []);

  return (
    <Overlay onDismiss={onClose}>
      <div className="dialog archive" role="dialog" aria-modal="true" aria-label="Pressed leaves">
        <div className="dialog-head">
          <h3>🍂 Pressed leaves</h3>
          <p className="muted">Shipped work, kept for the record.</p>
        </div>
        {specimens === null && <p className="muted">Leafing through…</p>}
        {specimens?.length === 0 && <p className="muted">Nothing pruned yet — the scrapbook is empty.</p>}
        <div className="archive-grid">
          {specimens?.map((s) => (
            <div key={s.id} className="leaf">
              <SproutAvatar seed={s.avatarSeed} stage={s.stage} size={48} />
              <div className="leaf-info">
                <div className="specimen-name" title={`branch: ${s.branch}`}>
                  {s.name}
                </div>
                <div className="specimen-meta">
                  {s.repo} · planted {age(s.createdAt)} ago · pruned{' '}
                  {s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : '—'}
                </div>
                <div className="leaf-checks">
                  {CHECK_LABELS.map(({ key, label }) => (
                    <span key={key} className={`mini-check ${s.checklist[key] ? 'on' : ''}`}>
                      {s.checklist[key] ? '✓' : '·'} {label}
                    </span>
                  ))}
                </div>
                {s.notes && <div className="leaf-notes">{s.notes}</div>}
              </div>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Back to the Terrarium
          </button>
        </div>
      </div>
    </Overlay>
  );
}
