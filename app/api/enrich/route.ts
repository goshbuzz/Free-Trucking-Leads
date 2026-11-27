import { NextResponse } from 'next/server';
import { enrichDots } from '@/lib/enrich';
import { limits } from '@/lib/env';
import { parseDot } from '@/lib/normalize';
import { parseCsv, findDotColumn } from '@/lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface EnrichBody {
  dots?: unknown;
  csv?: unknown;
  maxRows?: unknown;
}

/**
 * POST /api/enrich
 *
 * Body: { dots: string[] }   — DOT numbers, sent verbatim from the CSV column
 *   or: { csv: string }      — a raw CSV, parsed server-side
 *
 * Two response shapes, chosen by `Accept`:
 *   application/json          — one JSON document (default, used by scripts)
 *   text/event-stream         — newline-delimited JSON events, used by the UI so
 *                               progress reflects real lookups instead of a timer
 *
 * The browser only ever uploads DOT numbers, so a 5,000-row list costs a few KB
 * and the FMCSA key never leaves the server.
 */
export async function POST(request: Request) {
  const limit = limits();
  let body: EnrichBody;

  try {
    body = (await request.json()) as EnrichBody;
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON with a "dots" array.' }, { status: 400 });
  }

  let dots: string[];

  if (Array.isArray(body.dots)) {
    dots = body.dots.map((value) => String(value ?? '').trim());
  } else if (typeof body.csv === 'string') {
    const parsed = parseCsv(body.csv);
    const column = findDotColumn(parsed.headers, parsed.rows);
    if (column === null) {
      return NextResponse.json(
        { error: 'Could not find a USDOT column in that CSV. Include a column named DOT, DOT Number or USDOT.' },
        { status: 422 },
      );
    }
    dots = parsed.rows.map((row) => row[column] ?? '');
  } else {
    return NextResponse.json({ error: 'Send { "dots": [...] } or { "csv": "..." }.' }, { status: 400 });
  }

  dots = dots.filter((dot) => dot.length > 0);
  if (dots.length === 0) {
    return NextResponse.json({ error: 'No USDOT numbers were supplied.' }, { status: 422 });
  }

  const maxRows = Math.min(limit.maxRowsPerFile, Number(body.maxRows) > 0 ? Number(body.maxRows) : limit.maxRowsPerFile);
  if (dots.length > maxRows) {
    return NextResponse.json(
      { error: `This run has ${dots.length} rows; the limit is ${maxRows.toLocaleString('en-US')} per request. Split the file and try again.` },
      { status: 413 },
    );
  }

  if (dots.filter((dot) => parseDot(dot) !== null).length === 0) {
    return NextResponse.json(
      {
        error:
          'None of the supplied cells could be read as a USDOT number. Use the digits from the DOT column (for example 1234567); MC/MX docket numbers are a different identifier.',
      },
      { status: 422 },
    );
  }

  const wantsStream = request.headers.get('accept')?.includes('text/event-stream') ?? false;
  const started = Date.now();

  if (!wantsStream) {
    try {
      const result = await enrichDots(dots, { signal: request.signal });
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'no-store', 'Server-Timing': `enrich;dur=${Date.now() - started}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json({ error: `Enrichment failed: ${message}` }, { status: 502 });
    }
  }

  /* Streaming response ---------------------------------------------------- */
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      // Keep proxies from closing an idle connection while a slow batch runs.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keep-alive\n'));
        } catch {
          /* stream already closed */
        }
      }, 10_000);

      try {
        const result = await enrichDots(dots, {
          signal: request.signal,
          onProgress: (done, total) => {
            try {
              send({ type: 'progress', done, total });
            } catch {
              /* client disconnected */
            }
          },
        });
        send({ type: 'result', payload: result });
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : 'Enrichment failed' });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'Server-Timing': `enrich;dur=${Date.now() - started}`,
    },
  });
}

export async function GET() {
  return NextResponse.json({
    usage: 'POST { "dots": ["1234567", ...] } or { "csv": "<raw csv text>" }',
    limits: limits(),
  });
}
