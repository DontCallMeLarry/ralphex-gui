import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const options = { gfm: true, breaks: true };

/**
 * Two parsers rather than one. marked renders task lists disabled, which is
 * right for a transcript nobody can edit and wrong for the brief, whose boxes
 * write back to the file — and a disabled input fires no click at all.
 */
const reading = new Marked(options);
const ticking = new Marked(options, {
  renderer: {
    checkbox: ({ checked }) => `<input type="checkbox"${checked ? ' checked' : ''}>`,
  },
});

export function Markdown({ text, liveTasks = false }: { text: string; liveTasks?: boolean }) {
  const html = DOMPurify.sanitize((liveTasks ? ticking : reading).parse(text, { async: false }));
  return (
    <div
      className={`markdown${liveTasks ? ' live-tasks' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
