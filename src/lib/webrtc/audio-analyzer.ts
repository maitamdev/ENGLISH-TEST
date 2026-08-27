export function createVoiceActivityMonitor(stream: MediaStream, onActivity: (active: boolean) => void) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let frame = 0;
  let last = false;

  function tick() {
    analyser.getByteFrequencyData(data);
    const average = data.reduce((sum, value) => sum + value, 0) / data.length;
    const active = average > 18;
    if (active !== last) { last = active; onActivity(active); }
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    void context.close();
  };
}
