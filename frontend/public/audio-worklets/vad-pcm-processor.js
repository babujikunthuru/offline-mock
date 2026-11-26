class VadPcmProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]

    if (input && output) {
      input.forEach((channel, index) => {
        if (output[index]) output[index].set(channel)
      })
    }

    return true
  }
}

registerProcessor('vad-pcm-processor', VadPcmProcessor)
