// @vitest-environment jsdom
/** Input methods that rewrite a word with Backspace and then insert keep their inserted text. */
import { vi } from 'vitest'

// Lexical reads beforeinput only where InputEvent has getTargetRanges (decided at import); jsdom lacks it.
vi.hoisted(() => {
  Object.defineProperty(window.InputEvent.prototype, 'getTargetRanges', {
    configurable: true,
    value(this: InputEvent): StaticRange[] { return (this as InputEvent & { ranges?: StaticRange[] }).ranges ?? [] },
  })
})

import { expect, it, onTestFinished } from 'vitest'
import { $getRoot } from 'lexical'
import { DraftEditorRuntime } from '../src/client/input/editor/runtime.ts'

function fixture(draft: string) {
  // jsdom has no Range geometry; these cases observe text, not scrolling.
  const geometry = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
  onTestFinished(() => {
    if (geometry === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    else Object.defineProperty(Range.prototype, 'getBoundingClientRect', geometry)
  })
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  document.body.append(root)
  const runtime: DraftEditorRuntime = new DraftEditorRuntime({
    onUpdate: () => { runtime.refreshProjection() },
    openReference: () => false, activeClaimToken: () => null,
    lexicon: () => new Map(), resolveLexicon: () => undefined,
  })
  const dispose = runtime.register()
  const { editor } = runtime
  onTestFinished(() => { dispose(); root.remove() })
  editor.setRootElement(root)
  runtime.setDraft(draft)
  root.focus()
  editor.update(() => { $getRoot().selectEnd() }, { discrete: true })
  // read() commits the pending update first, as the next browser task would.
  const text = (): string => editor.read(() => $getRoot().getTextContent())
  const backspace = (): void => {
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
  }
  const insert = (data: string, ranges: StaticRange[] = []): InputEvent => {
    const event = new InputEvent('beforeinput', { inputType: 'insertText', data, bubbles: true, cancelable: true })
    Object.assign(event, { ranges })
    root.dispatchEvent(event)
    return event
  }
  return { root, text, backspace, insert }
}

it('inserts the text an input method sends right after its own Backspaces', () => {
  // Telex "toi" + "o": two Backspaces, then "ôi" with no keydown of its own.
  // jsdom cannot move a DOM selection, so Lexical's Backspace may delete nothing here; the
  // inserted text must still land after whatever it left.
  const f = fixture('t')
  f.backspace()
  f.backspace()
  const left = f.text()
  const event = f.insert('ôi')
  expect(event.defaultPrevented).toBe(true)
  expect(f.text()).toBe(`${left}ôi`)
})

it('leaves a range replacement after Backspace to Lexical', () => {
  const f = fixture('omw')
  f.backspace()
  const left = f.text()
  const node = f.root.querySelector('span')!.firstChild!
  const ranges = [new StaticRange({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 2 })]
  f.insert('On my way!', ranges)
  expect(f.text()).toBe(left)
})

it('leaves ordinary typing to Lexical once the Backspace task has passed', async () => {
  const f = fixture('ab')
  f.backspace()
  await new Promise(resolve => setTimeout(resolve, 0))
  const event = f.insert('c')
  // Lexical lets the browser insert ordinary text natively; this handler did not take it.
  expect(event.defaultPrevented).toBe(false)
})
