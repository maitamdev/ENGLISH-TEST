export type SignalMessage =
  | { type: "webrtc_offer"; senderId: string; payload: RTCSessionDescriptionInit }
  | { type: "webrtc_answer"; senderId: string; payload: RTCSessionDescriptionInit }
  | { type: "ice_candidate"; senderId: string; payload: RTCIceCandidateInit };

export type SignalingTransport = {
  send: (message: SignalMessage) => Promise<void>;
  subscribe: (listener: (message: SignalMessage) => void) => () => void;
};
