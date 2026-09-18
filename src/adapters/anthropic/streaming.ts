import type { Response } from 'express';
import type { AnthropicMessagesResponse } from '../../utils/formatAdapters';
import { estimateTokens } from '../../utils/formatAdapters';

/**
 * Server-Sent Events for the Anthropic Messages protocol.
 *
 * The previous implementation accepted `stream: true`, logged it, and returned a plain
 * JSON body. Every Anthropic SDK requests streaming by default, so clients received a
 * body they never asked for and could not parse.
 *
 * The wire rules implemented here are from the in-tree reference
 * (docs/anthropic-messages-api-reference.md §6) and its proxy checklist:
 *   - Named events: the `event:` name matches `data.type`.
 *   - `message_start` carries a full message with `content: []` and `stop_reason: null`.
 *   - `message_delta.usage` is **cumulative** and is a different shape from
 *     `message_start.message.usage`.
 *   - Never emit `data: [DONE]` — that is an openclaw convention, not Anthropic's.
 *   - `ping` keeps intermediaries from idling out the connection.
 */

export interface SseWriter {
  /** Write one named event. */
  event(name: string, payload: Record<string, unknown>): void;
  /** Terminate the stream. */
  end(): void;
  /** Whether the client is still connected. */
  readonly open: boolean;
}

/** Prepare the response for SSE and return a writer. */
export function startSse(res: Response): SseWriter {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering (nginx) so frames arrive as they are written.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let open = true;
  res.on('close', () => {
    open = false;
  });

  return {
    get open() {
      return open;
    },
    event(name: string, payload: Record<string, unknown>) {
      if (!open) return;
      // The event name and the payload's `type` must agree.
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    end() {
      if (!open) return;
      open = false;
      res.end();
    },
  };
}

/**
 * Emit a completed message as an Anthropic SSE stream.
 *
 * The image is produced before streaming begins (generation is not incremental), so the
 * sequence is emitted in one pass. The frame order is what clients validate, so it is
 * spelled out explicitly rather than implied.
 */
export function streamMessage(
  res: Response,
  message: AnthropicMessagesResponse,
  options: { pingFirst?: boolean } = {},
): void {
  const sse = startSse(res);

  sse.event('message_start', {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [], // must be empty at start
      stop_reason: null, // null until message_delta
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: 0,
      },
    },
  });

  if (options.pingFirst) {
    sse.event('ping', { type: 'ping' });
  }

  // Cumulative output tokens, as the spec requires for message_delta.
  let cumulativeOutputTokens = 0;

  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      sse.event('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });

      sse.event('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });

      cumulativeOutputTokens += estimateTokens(block.text);
    } else if (block.type === 'tool_use') {
      // tool_use opens with an empty input, then streams the JSON as partial_json.
      sse.event('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });

      const partial = JSON.stringify(block.input);
      sse.event('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: partial },
      });

      cumulativeOutputTokens += estimateTokens(partial);
    } else if (block.type === 'image') {
      // The `image` block is a documented extension, not part of the response union.
      sse.event('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: block,
      });
      cumulativeOutputTokens += estimateTokens(block.source.data);
    }

    sse.event('content_block_stop', { type: 'content_block_stop', index });
  });

  sse.event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
    usage: { output_tokens: cumulativeOutputTokens },
  });

  sse.event('message_stop', { type: 'message_stop' });

  sse.end();
}

/** Emit an error mid-stream, after the 200 has already been sent. */
export function streamError(res: Response, type: string, message: string): void {
  const sse = startSse(res);
  // Note: in-stream error events carry no request_id, per the reference doc.
  sse.event('error', { type: 'error', error: { type, message } });
  sse.end();
}
