// The page the browser lands on after `holodeck login` (HOL-239): the last
// thing a person sees of signing in, served by the login's own local server
// (holodeckLogin.ts) right before it closes.
//
// Everything is inline. The page comes from 127.0.0.1, from a process that is
// gone a moment later, and a failed sign-in may mean Holodeck itself can't be
// reached: it can load no font, image or stylesheet from anywhere. So it uses
// the system's font and Holodeck's own dark colors and mark, written here.
//
// It says the tab can be closed and does not try to close it: a browser only
// lets a script close a tab that a script opened.

export interface LoginPage {
  title: string
  // One paragraph each, as plain text: escaped when the page is drawn.
  lines: string[]
  // A command to run next, shown apart from the text.
  command?: string
}

const RETRY_LINE = 'Return to your terminal and run the command again.'
const RETRY_COMMAND = 'holodeck login'

export const SIGNED_IN_PAGE: LoginPage = {
  title: 'Signed in',
  lines: ['You can close this tab and return to your terminal.', 'To put one of your Agents to work, run this in your project folder:'],
  command: 'holodeck agent setup',
}

export const STATE_MISMATCH_PAGE: LoginPage = {
  title: 'Sign-in failed',
  lines: ['This page does not belong to the sign-in that is running now. It may be from an earlier attempt.', RETRY_LINE],
  command: RETRY_COMMAND,
}

export const NO_CODE_PAGE: LoginPage = {
  title: 'Sign-in failed',
  lines: ['Holodeck sent no authorization code back.', RETRY_LINE],
  command: RETRY_COMMAND,
}

// `reason` is whatever the address the browser was sent back to says went
// wrong. It comes from outside, so it reaches the page as text only.
export function failedPage(reason: string): LoginPage {
  return {
    title: 'Sign-in failed',
    lines: [`Holodeck answered: ${reason}`, RETRY_LINE],
    command: RETRY_COMMAND,
  }
}

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character)
}

// Holodeck's mark, the one the app's tab shows (frontend/public/favicon.svg).
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="40" height="40" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#ebebeb"/><g transform="translate(7 7) scale(0.75)" fill="none" stroke="#08090a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v1c0 1 2 1 2 2S3 6 3 7s2 1 2 2-2 1-2 2 2 1 2 2"/><path d="M18 6h.01"/><path d="M6 18h.01"/><path d="M20.83 8.83a4 4 0 0 0-5.66-5.66l-12 12a4 4 0 1 0 5.66 5.66Z"/><path d="M18 11.66V22a4 4 0 0 0 4-4V6"/></g></svg>`

// The app's dark theme (frontend/src/theme): its ground, surface, text and
// border colors. Dark only, as the app is.
const STYLE = `
  * { box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: #08090a;
    color: #e5e5e6;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main {
    width: 100%;
    max-width: 420px;
    padding: 28px;
    border: 1px solid #23252a;
    border-radius: 12px;
    background: #161718;
  }
  h1 { margin: 20px 0 8px; font-size: 20px; line-height: 1.3; font-weight: 600; }
  p { margin: 0 0 8px; color: #8a8f98; overflow-wrap: anywhere; }
  code {
    display: block;
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid #23252a;
    border-radius: 8px;
    background: #08090a;
    color: #e5e5e6;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow-wrap: anywhere;
  }
`

export function renderLoginPage(page: LoginPage): string {
  const lines = page.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
  const command = page.command === undefined ? '' : `<code>${escapeHtml(page.command)}</code>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)} · Holodeck</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${MARK}
<h1>${escapeHtml(page.title)}</h1>
${lines}
${command}
</main>
</body>
</html>
`
}
