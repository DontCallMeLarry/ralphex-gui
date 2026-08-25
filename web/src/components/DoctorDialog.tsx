import { useEffect, useState } from 'react';
import { api, type DoctorReport } from '../api.ts';
import { Overlay } from './Overlay.tsx';

/**
 * What is missing, and the command that fixes it.
 *
 * A web page cannot install anything, so this hands over the line to paste
 * instead. It exists only when something is actually missing — when everything
 * is present nobody ever sees it.
 */
export function DoctorDialog({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.doctor().then(
      (result) => live && setReport(result),
      (err) => live && setProblem((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <Overlay onDismiss={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="What has to be installed">
        <div className="dialog-head">
          <div className="brief-title">
            <h3>Before anything can grow</h3>
            <p className="muted">Sprouting and the bench need these. Everything else in the Terrarium does not.</p>
          </div>
        </div>

        {!report && !problem && <p className="muted">Looking…</p>}
        {problem && <p className="warn">{problem}</p>}

        {report?.checks.map((check) => (
          <div className={`tool-check${check.found ? ' found' : ''}`} key={check.id}>
            <div className="tool-check-head">
              <span className="mark" aria-hidden="true">
                {check.found ? '✓' : check.required ? '✖' : '○'}
              </span>
              <strong>{check.label}</strong>
              <span className="muted">{check.found ? check.version : check.required ? 'missing' : 'optional'}</span>
            </div>
            <p className="muted small">{check.why}</p>
            {!check.found &&
              check.install.map((step) => (
                <div className="install-line" key={step.command}>
                  <span className="muted small">{step.label}</span>
                  {step.kind === 'link' ? (
                    <a href={step.command} target="_blank" rel="noreferrer">
                      {step.command}
                    </a>
                  ) : (
                    <>
                      <code>{step.command}</code>
                      <button
                        className="btn subtle"
                        onClick={() => {
                          void navigator.clipboard.writeText(step.command);
                          setCopied(step.command);
                        }}
                      >
                        {copied === step.command ? 'copied' : 'copy'}
                      </button>
                    </>
                  )}
                </div>
              ))}
          </div>
        ))}

        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}
