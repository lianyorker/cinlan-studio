import { creativeOwnerContext } from '@/lib/server/creative/context'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { listCreativeEvents } from '@/lib/server/creative/repository'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { owner } = await creativeOwnerContext()
    const { id } = await context.params
    const url = new URL(request.url)
    const initialAfter = Math.max(0, Number(url.searchParams.get('after') || request.headers.get('last-event-id') || 0))
    if (url.searchParams.get('stream') !== '1') return Response.json({ events: await listCreativeEvents(owner.id, id, initialAfter) })
    const initialEvents = await listCreativeEvents(owner.id, id, initialAfter)

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        let after = initialAfter
        const deadline = Date.now() + 25_000
        controller.enqueue(encoder.encode('retry: 1000\n\n'))
        try {
          for (const event of initialEvents) {
            after = event.id
            controller.enqueue(encoder.encode(`id: ${event.id}\nevent: creative\ndata: ${JSON.stringify(event)}\n\n`))
          }
          while (!request.signal.aborted && Date.now() < deadline) {
            const events = await listCreativeEvents(owner.id, id, after)
            for (const event of events) {
              after = event.id
              controller.enqueue(encoder.encode(`id: ${event.id}\nevent: creative\ndata: ${JSON.stringify(event)}\n\n`))
            }
            if (!events.length) controller.enqueue(encoder.encode(': keepalive\n\n'))
            await new Promise((resolve) => setTimeout(resolve, 750))
          }
        } catch (error) {
          console.error('[creative-core] activity stream failed', { message: error instanceof Error ? error.message : String(error) })
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: 'Activity stream failed' })}\n\n`))
        } finally {
          controller.close()
        }
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } })
  } catch (error) {
    return creativeErrorResponse(error)
  }
}
