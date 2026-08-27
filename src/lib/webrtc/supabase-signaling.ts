import type { RealtimeChannel } from "@supabase/supabase-js";
import type { SignalMessage, SignalingTransport } from "./signaling";

export function createSupabaseSignaling(channel: RealtimeChannel): SignalingTransport {
  return {
    async send(message) {
      await channel.send({ type: "broadcast", event: message.type, payload: message });
    },
    subscribe(listener) {
      const events: SignalMessage["type"][] = ["webrtc_offer", "webrtc_answer", "ice_candidate"];
      events.forEach((event) => channel.on("broadcast", { event }, ({ payload }) => listener(payload as SignalMessage)));
      void channel.subscribe();
      return () => { void channel.unsubscribe(); };
    }
  };
}
