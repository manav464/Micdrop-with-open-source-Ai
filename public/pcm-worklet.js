class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.position = 0;
    this.pending = [];
    this.frameSize = 320;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    while (this.position < channel.length) {
      const i = Math.floor(this.position);
      const frac = this.position - i;
      const a = channel[i] || 0;
      const b = channel[Math.min(i + 1, channel.length - 1)] || a;
      this.pending.push(a + (b - a) * frac);
      this.position += this.ratio;
      if (this.pending.length >= this.frameSize) {
        const pcm = new Int16Array(this.frameSize);
        for (let n = 0; n < this.frameSize; n++)
          pcm[n] =
            Math.max(-1, Math.min(1, this.pending[n])) *
            (this.pending[n] < 0 ? 32768 : 32767);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.pending = this.pending.slice(this.frameSize);
      }
    }
    this.position -= channel.length;
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
