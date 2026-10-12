import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NO_CODE_PAGE, SIGNED_IN_PAGE, STATE_MISMATCH_PAGE, escapeHtml, failedPage, renderLoginPage } from './loginPage.js'

// The page after `holodeck login` (HOL-239). The reason a sign-in failed comes
// from the address the browser was sent to, which anyone can write: it must
// reach the page as text, never as markup.

describe('what comes from outside', () => {
  it('escapes the characters that would make text into markup', () => {
    assert.equal(escapeHtml(`<img src=x onerror="alert('hi')"> & more`), '&lt;img src=x onerror=&quot;alert(&#39;hi&#39;)&quot;&gt; &amp; more')
  })

  it('draws a failure reason as text', () => {
    const html = renderLoginPage(failedPage('<script>alert(1)</script>'))

    assert.ok(!html.includes('<script>'))
    assert.match(html, /Holodeck answered: &lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  })

  it('leaves an ordinary reason readable', () => {
    assert.match(renderLoginPage(failedPage('access_denied')), /<p>Holodeck answered: access_denied<\/p>/)
  })
})

describe('the four pages', () => {
  const pages = [SIGNED_IN_PAGE, STATE_MISMATCH_PAGE, NO_CODE_PAGE, failedPage('access_denied')]

  it('share one template: a whole document, sized for a small window, with nothing loaded from elsewhere', () => {
    for (const page of pages) {
      const html = renderLoginPage(page)
      assert.match(html, /^<!doctype html>/)
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/)
      assert.match(html, new RegExp(`<h1>${page.title}</h1>`))
      // The server that answers is gone a moment later.
      assert.ok(!/(src|href)=/.test(html))
      assert.ok(!html.includes('url('))
    }
  })

  it('tells a person who signed in what to run next, and one who did not how to try again', () => {
    assert.match(renderLoginPage(SIGNED_IN_PAGE), /<code>holodeck agent setup<\/code>/)
    for (const page of pages.slice(1)) {
      assert.match(renderLoginPage(page), /<code>holodeck login<\/code>/)
    }
  })
})
