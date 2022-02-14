import { pipe } from 'it-pipe'
import { Pushable, pushableV } from 'it-pushable'
import { abortableSource } from 'abortable-iterator'
import { encode } from './encode.js'
import { decode } from './decode.js'
import { restrictSize } from './restrict-size.js'
import { MessageTypes, MessageTypeNames, Message } from './message-types.js'
import { createStream } from './stream.js'
import { toString as uint8ArrayToString } from 'uint8arrays'
import { trackedMap } from '@libp2p/tracked-map'
import { logger } from '@libp2p/logger'
import type { AbortOptions } from '@libp2p/interfaces'
import type { Sink } from 'it-stream-types'
import type { Muxer } from '@libp2p/interfaces/stream-muxer'
import type { Stream } from '@libp2p/interfaces/connection'
import type { ComponentMetricsTracker } from '@libp2p/interfaces/metrics'
import each from 'it-foreach'

const log = logger('libp2p:mplex')

function printMessage (msg: Message) {
  const output: any = {
    ...msg,
    type: `${MessageTypeNames[msg.type]} (${msg.type})`
  }

  if (msg.type === MessageTypes.NEW_STREAM) {
    output.data = uint8ArrayToString(msg.data instanceof Uint8Array ? msg.data : msg.data.slice())
  }

  if (msg.type === MessageTypes.MESSAGE_INITIATOR || msg.type === MessageTypes.MESSAGE_RECEIVER) {
    output.data = uint8ArrayToString(msg.data instanceof Uint8Array ? msg.data : msg.data.slice(), 'base16')
  }

  return output
}

export interface MplexStream extends Stream {
  source: Pushable<Uint8Array>
}

export interface MplexOptions extends AbortOptions {
  onStream?: (...args: any[]) => void
  onStreamEnd?: (...args: any[]) => void
  maxMsgSize?: number
  metrics?: ComponentMetricsTracker
}

export class Mplex implements Muxer {
  static multicodec = '/mplex/6.7.0'

  public sink: Sink<Uint8Array>
  public source: AsyncIterable<Uint8Array>

  private _streamId: number
  private readonly _streams: { initiators: Map<number, MplexStream>, receivers: Map<number, MplexStream> }
  private readonly _options: MplexOptions
  private readonly _source: { push: (val: Message) => void, end: (err?: Error) => void }

  constructor (options?: MplexOptions) {
    options = options ?? {}

    this._streamId = 0
    this._streams = {
      /**
       * Stream to ids map
       */
      initiators: trackedMap<number, MplexStream>({ metrics: options.metrics, component: 'mplex', metric: 'initiatorStreams' }),
      /**
       * Stream to ids map
       */
      receivers: trackedMap<number, MplexStream>({ metrics: options.metrics, component: 'mplex', metric: 'receiverStreams' })
    }
    this._options = options

    /**
     * An iterable sink
     */
    this.sink = this._createSink()

    /**
     * An iterable source
     */
    const source = this._createSource()
    this._source = source
    this.source = source
  }

  /**
   * Returns a Map of streams and their ids
   */
  get streams () {
    // Inbound and Outbound streams may have the same ids, so we need to make those unique
    const streams: Stream[] = []
    this._streams.initiators.forEach(stream => {
      streams.push(stream)
    })
    this._streams.receivers.forEach(stream => {
      streams.push(stream)
    })
    return streams
  }

  /**
   * Initiate a new stream with the given name. If no name is
   * provided, the id of the stream will be used.
   */
  newStream (name?: string): Stream {
    const id = this._streamId++
    name = name == null ? id.toString() : name.toString()
    const registry = this._streams.initiators
    return this._newStream({ id, name, type: 'initiator', registry })
  }

  /**
   * Called whenever an inbound stream is created
   */
  _newReceiverStream (options: { id: number, name: string }) {
    const { id, name } = options
    const registry = this._streams.receivers
    return this._newStream({ id, name, type: 'receiver', registry })
  }

  _newStream (options: { id: number, name: string, type: 'initiator' | 'receiver', registry: Map<number, MplexStream> }) {
    const { id, name, type, registry } = options

    log('new %s stream %s %s', type, id, name)

    if (registry.has(id)) {
      throw new Error(`${type} stream ${id} already exists!`)
    }

    const send = (msg: Message) => {
      if (log.enabled) {
        log('%s stream %s send', type, id, printMessage(msg))
      }

      if (msg.type === MessageTypes.NEW_STREAM || msg.type === MessageTypes.MESSAGE_INITIATOR || msg.type === MessageTypes.MESSAGE_RECEIVER) {
        msg.data = msg.data instanceof Uint8Array ? msg.data : msg.data.slice()
      }

      this._source.push(msg)
    }

    const onEnd = () => {
      log('%s stream %s %s ended', type, id, name)
      registry.delete(id)

      if (this._options.onStreamEnd != null) {
        this._options.onStreamEnd(stream)
      }
    }

    const stream = createStream({ id, name, send, type, onEnd, maxMsgSize: this._options.maxMsgSize })
    registry.set(id, stream)
    return stream
  }

  /**
   * Creates a sink with an abortable source. Incoming messages will
   * also have their size restricted. All messages will be varint decoded.
   */
  _createSink () {
    const sink: Sink<Uint8Array> = async source => {
      if (this._options.signal != null) {
        source = abortableSource(source, this._options.signal)
      }

      try {
        await pipe(
          source,
          source => each(source, (buf) => {
            // console.info('incoming', uint8ArrayToString(buf, 'base64'))
          }),
          decode,
          restrictSize(this._options.maxMsgSize),
          async source => {
            for await (const msg of source) {
              this._handleIncoming(msg)
            }
          }
        )

        this._source.end()
      } catch (err: any) {
        log('error in sink', err)
        this._source.end(err) // End the source with an error
      }
    }

    return sink
  }

  /**
   * Creates a source that restricts outgoing message sizes
   * and varint encodes them
   */
  _createSource () {
    const onEnd = (err?: Error) => {
      const { initiators, receivers } = this._streams
      // Abort all the things!
      for (const s of initiators.values()) {
        s.abort(err)
      }
      for (const s of receivers.values()) {
        s.abort(err)
      }
    }
    const source = pushableV<Message>({ onEnd })
    /*
    const p = pipe(
      source,
      source => each(source, (msgs) => {
        if (log.enabled) {
          msgs.forEach(msg => {
            log('outgoing message', printMessage(msg))
          })
        }
      }),
      source => encode(source),
      source => each(source, (buf) => {
        console.info('outgoing', uint8ArrayToString(buf, 'base64'))
      })
    )

    return Object.assign(p, {
      push: source.push,
      end: source.end,
      return: source.return
    })
*/
    return Object.assign(encode(source), {
      push: source.push,
      end: source.end,
      return: source.return
    })
  }

  _handleIncoming (message: Message) {
    const { id, type } = message

    if (log.enabled) {
      log('incoming message', printMessage(message))
    }

    // Create a new stream?
    if (message.type === MessageTypes.NEW_STREAM) {
      const stream = this._newReceiverStream({ id, name: uint8ArrayToString(message.data instanceof Uint8Array ? message.data : message.data.slice()) })

      if (this._options.onStream != null) {
        this._options.onStream(stream)
      }

      return
    }

    const list = (type & 1) === 1 ? this._streams.initiators : this._streams.receivers
    const stream = list.get(id)

    if (stream == null) {
      return log('missing stream %s', id)
    }

    switch (type) {
      case MessageTypes.MESSAGE_INITIATOR:
      case MessageTypes.MESSAGE_RECEIVER:
        stream.source.push(message.data.slice())
        break
      case MessageTypes.CLOSE_INITIATOR:
      case MessageTypes.CLOSE_RECEIVER:
        stream.close()
        break
      case MessageTypes.RESET_INITIATOR:
      case MessageTypes.RESET_RECEIVER:
        stream.reset()
        break
      default:
        log('unknown message type %s', type)
    }
  }
}
