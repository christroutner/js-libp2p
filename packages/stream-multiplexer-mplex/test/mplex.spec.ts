/* eslint-env mocha */
/* eslint max-nested-callbacks: ["error", 5] */

import { defaultLogger } from '@libp2p/logger'
import { expect } from 'aegir/chai'
import delay from 'delay'
import all from 'it-all'
import { pushable } from 'it-pushable'
import pDefer from 'p-defer'
import { Uint8ArrayList } from 'uint8arraylist'
import { concat as uint8ArrayConcat } from 'uint8arrays/concat'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { encode } from '../src/encode.js'
import { mplex } from '../src/index.js'
import { type CloseInitiatorMessage, type Message, type MessageInitiatorMessage, MessageTypes, type NewStreamMessage } from '../src/message-types.js'
import { decode } from './fixtures/decode.js'
import type { Source } from 'it-stream-types'

describe('mplex', () => {
  it('should restrict number of initiator streams per connection', async () => {
    const maxOutboundStreams = 10
    const factory = mplex({
      maxOutboundStreams
    })({
      logger: defaultLogger()
    })
    const muxer = factory.createStreamMuxer()

    // max out the streams for this connection
    for (let i = 0; i < maxOutboundStreams; i++) {
      await muxer.newStream()
    }

    // open one more
    await expect((async () => {
      await muxer.newStream()
    })()).eventually.be.rejected
      .with.property('code', 'ERR_TOO_MANY_OUTBOUND_STREAMS')
  })

  it('should restrict number of recipient streams per connection', async () => {
    const maxInboundStreams = 10
    const factory = mplex({
      maxInboundStreams,
      disconnectThreshold: Infinity
    })({
      logger: defaultLogger()
    })
    const muxer = factory.createStreamMuxer()
    const stream = pushable()

    // max out the streams for this connection
    for (let i = 0; i < maxInboundStreams; i++) {
      const source: NewStreamMessage[][] = [[{
        id: i,
        type: 0,
        data: new Uint8ArrayList(uint8ArrayFromString('17'))
      }]]

      const data = uint8ArrayConcat(await all(encode(source)))

      stream.push(data)
    }

    // simulate a new incoming stream
    const source: NewStreamMessage[][] = [[{
      id: 11,
      type: 0,
      data: new Uint8ArrayList(uint8ArrayFromString('17'))
    }]]

    const data = uint8ArrayConcat(await all(encode(source)))

    stream.push(data)
    stream.end()

    const bufs: Uint8Array[] = []
    const sinkDone = pDefer()

    void Promise.resolve().then(async () => {
      for await (const buf of muxer.source) {
        bufs.push(buf)
      }
      sinkDone.resolve()
    })

    await muxer.sink(stream)
    await sinkDone.promise

    const messages = await all(decode()(bufs))

    expect(messages).to.have.nested.property('[0].id', 11, 'Did not specify the correct stream id')
    expect(messages).to.have.nested.property('[0].type', MessageTypes.RESET_RECEIVER, 'Did not reset the stream that tipped us over the inbound stream limit')
  })

  it('should reset a stream that fills the message buffer', async () => {
    let sent = 0
    const streamSourceError = pDefer<Error>()
    const maxStreamBufferSize = 1024 * 1024 // 1MB
    const id = 17

    // simulate a new incoming stream that sends lots of data
    const input: Source<Message[]> = (async function * send () {
      const newStreamMessage: NewStreamMessage = {
        id,
        type: MessageTypes.NEW_STREAM,
        data: new Uint8ArrayList(new Uint8Array(1024))
      }
      yield [newStreamMessage]

      await delay(10)

      for (let i = 0; i < 100; i++) {
        const dataMessage: MessageInitiatorMessage = {
          id,
          type: MessageTypes.MESSAGE_INITIATOR,
          data: new Uint8ArrayList(new Uint8Array(1024 * 1000))
        }
        yield [dataMessage]

        sent++

        await delay(10)
      }

      await delay(10)

      const closeMessage: CloseInitiatorMessage = {
        id,
        type: MessageTypes.CLOSE_INITIATOR
      }
      yield [closeMessage]
    })()

    // create the muxer
    const factory = mplex({
      maxStreamBufferSize
    })({
      logger: defaultLogger()
    })
    const muxer = factory.createStreamMuxer({
      onIncomingStream () {
        // do nothing with the stream so the buffer fills up
      },
      onStreamEnd (stream) {
        void all(stream.source)
          .then(() => {
            streamSourceError.reject(new Error('Stream source did not error'))
          })
          .catch(err => {
            // should have errored before all 102 messages were sent
            expect(sent).to.be.lessThan(10)
            streamSourceError.resolve(err)
          })
      }
    })

    // collect outgoing mplex messages
    const muxerFinished = pDefer()
    const messages: Message[] = []
    void Promise.resolve().then(async () => {
      try {
        // collect as many messages as possible
        for await (const message of decode()(muxer.source)) {
          messages.push(message)
        }
      } catch {}
      muxerFinished.resolve()
    })

    // the muxer processes the messages
    void muxer.sink(encode(input))

    // source should have errored with appropriate code
    const err = await streamSourceError.promise
    expect(err).to.have.property('code', 'ERR_STREAM_INPUT_BUFFER_FULL')

    // should have sent reset message to peer for this stream
    await muxerFinished.promise
    expect(messages).to.have.nested.property('[0].id', id)
    expect(messages).to.have.nested.property('[0].type', MessageTypes.RESET_RECEIVER)
  })

  it('should batch bytes to send', async () => {
    const minSendBytes = 10

    // input bytes, smaller than batch size
    const input: Uint8Array[] = [
      Uint8Array.from([0, 1, 2, 3, 4]),
      Uint8Array.from([0, 1, 2, 3, 4]),
      Uint8Array.from([0, 1, 2, 3, 4])
    ]

    // create the muxer
    const factory = mplex({
      minSendBytes
    })({
      logger: defaultLogger()
    })
    const muxer = factory.createStreamMuxer({})

    // collect outgoing mplex messages
    const muxerFinished = pDefer()
    let output: Uint8Array[] = []
    void Promise.resolve().then(async () => {
      output = await all(muxer.source)
      muxerFinished.resolve()
    })

    // create a stream
    const stream = await muxer.newStream()
    const streamFinished = pDefer()
    // send messages over the stream
    void Promise.resolve().then(async () => {
      await stream.sink(async function * () {
        yield * input
      }())
      await stream.close()
      streamFinished.resolve()
    })

    // wait for all data to be sent over the stream
    await streamFinished.promise

    // close the muxer
    await muxer.sink([])

    // wait for all output to be collected
    await muxerFinished.promise

    // last message is unbatched
    const closeMessage = output.pop()
    expect(closeMessage).to.have.lengthOf(2)

    // all other messages should be above or equal to the batch size
    expect(output).to.have.lengthOf(2)
    for (const buf of output) {
      expect(buf).to.have.length.that.is.at.least(minSendBytes)
    }
  })
})
