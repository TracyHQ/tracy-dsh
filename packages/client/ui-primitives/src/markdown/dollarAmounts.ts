/**
 * Tracy: keep dollar amounts out of inline math.
 *
 * `micromark-extension-math` opens inline math at any single `$` and closes it at the next single `$`, so a reply such as
 * "$49 per month and $99 per year" rendered "49 per month and " as one KaTeX formula. This construct runs before the
 * upstream one at every single `$` and reads it the way Pandoc does: it opens inline math only when the next character
 * is not a space and the dollar that would close it follows a non-space and is not followed by a digit. Otherwise the
 * `$` is plain text and the upstream construct never sees it. Runs of two or more dollars, escaped dollars and the
 * backslash delimiters are left exactly as before.
 */

import { asciiDigit, markdownLineEnding, markdownSpace } from 'micromark-util-character'
import { codes, types } from 'micromark-util-symbol'
import type { Construct, Extension, Previous, State, Tokenizer } from 'micromark-util-types'

// oxlint-disable typescript/no-this-alias -- micromark binds tokenizer context only on the outer callback.

/** Same rule as upstream math text: not inside a dollar run, unless that dollar was escaped. */
const previous: Previous = function (code) {
  if (code !== codes.dollarSign) return true
  const tail = this.events.at(-1)
  /* v8 ignore next -- a previous code necessarily has a preceding event. */
  if (tail === undefined) return false
  return tail[1].type === types.characterEscape
}

const blank = (code: number | null) => code === null || markdownSpace(code) || markdownLineEnding(code)

/**
 * Succeeds when the single `$` at the start is NOT the opening of inline math as Pandoc reads it. It consumes up to the
 * dollar upstream would close on; as a `check`, nothing it consumes is kept.
 */
const tokenizeNotMath: Tokenizer = function (effects, ok, nok) {
  let before: number | null = null
  let run = 0
  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- the construct is dispatched only for a dollar. */
    if (code !== codes.dollarSign) return nok(code)
    effects.enter(types.data)
    effects.consume(code)
    return afterOpen
  }

  function afterOpen(code: number | null): State | undefined {
    // A run of two or more dollars is upstream's, and so is a dollar with nothing after it.
    if (code === codes.dollarSign || code === codes.eof) return nok(code)
    // "$ 5": an opening dollar must touch what it opens.
    if (blank(code)) return ok(code)
    return inside(code)
  }

  function inside(code: number | null): State | undefined {
    // No closing dollar: upstream finds none either and leaves the `$` as text.
    if (code === codes.eof) return nok(code)
    if (code === codes.dollarSign) {
      run = 0
      return closing(code)
    }
    if (markdownLineEnding(code)) {
      effects.exit(types.data)
      effects.enter(types.lineEnding)
      effects.consume(code)
      effects.exit(types.lineEnding)
      effects.enter(types.data)
      before = code
      return inside
    }
    before = code
    effects.consume(code)
    return inside
  }

  function closing(code: number | null): State | undefined {
    if (code === codes.dollarSign) {
      run++
      effects.consume(code)
      return closing
    }
    // A run of another length is data to upstream; keep looking.
    if (run !== 1) {
      before = codes.dollarSign
      return inside(code)
    }
    // The dollar upstream would close on: "$49 and $99" (a space before it) or "$10-$20" (a digit after it).
    return blank(before) || asciiDigit(code) ? ok(code) : nok(code)
  }
}

const notMath: Construct = { partial: true, tokenize: tokenizeNotMath }

const tokenizeDollarAmount: Tokenizer = function (effects, ok, nok) {
  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- the construct is dispatched only for a dollar. */
    if (code !== codes.dollarSign) return nok(code)
    return effects.check(notMath, literal, nok)(code)
  }

  function literal(code: number | null): State | undefined {
    effects.enter(types.data)
    effects.consume(code)
    effects.exit(types.data)
    return ok
  }
}

const dollarAmount: Construct = { name: 'dollarAmount', previous, tokenize: tokenizeDollarAmount }

const extension: Extension = { text: { [codes.dollarSign]: dollarAmount } }

/**
 * The dollar-amount rule as a micromark syntax extension. List it AFTER `math()`: micromark tries the constructs of a
 * later extension first, and this one must see a `$` before upstream math text does.
 * @returns The micromark syntax extension.
 */
export function dollarAmounts(): Extension {
  return extension
}
