import type { SignalingTransport } from "./signaling";

type PeerManagerOptions = {
  localUserId: string;
  initiator: boolean;
  signaling: SignalingTransport;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
};

export class PeerManager {
  private peer: RTCPeerConnection;
  private unsubscribe?: () => void;

  constructor(private options: PeerManagerOptions) {
    const iceServers: RTCIceServer[] = [{ urls: process.env.NEXT_PUBLIC_STUN_URL || "stun:stun.l.google.com:19302" }];
    if (process.env.NEXT_PUBLIC_TURN_URL && process.env.NEXT_PUBLIC_TURN_USERNAME) {
      iceServers.push({ urls: process.env.NEXT_PUBLIC_TURN_URL, username: process.env.NEXT_PUBLIC_TURN_USERNAME, credential: "request-from-server" });
    }
    this.peer = new RTCPeerConnection({ iceServers });
    this.peer.ontrack = (event) => options.onRemoteStream(event.streams[0]);
    this.peer.onconnectionstatechange = () => options.onConnectionState(this.peer.connectionState);
    this.peer.onicecandidate = (event) => {
      if (event.candidate) void options.signaling.send({ type: "ice_candidate", senderId: options.localUserId, payload: event.candidate.toJSON() });
    };
  }

  async connect(localStream: MediaStream) {
    localStream.getTracks().forEach((track) => this.peer.addTrack(track, localStream));
    this.unsubscribe = this.options.signaling.subscribe((message) => void this.handleSignal(message));
    if (this.options.initiator) {
      const offer = await this.peer.createOffer();
      await this.peer.setLocalDescription(offer);
      await this.options.signaling.send({ type: "webrtc_offer", senderId: this.options.localUserId, payload: offer });
    }
  }

  private async handleSignal(message: Parameters<SignalingTransport["send"]>[0]) {
    if (message.senderId === this.options.localUserId) return;
    if (message.type === "webrtc_offer") {
      await this.peer.setRemoteDescription(message.payload);
      const answer = await this.peer.createAnswer();
      await this.peer.setLocalDescription(answer);
      await this.options.signaling.send({ type: "webrtc_answer", senderId: this.options.localUserId, payload: answer });
    } else if (message.type === "webrtc_answer") {
      await this.peer.setRemoteDescription(message.payload);
    } else if (message.type === "ice_candidate") {
      await this.peer.addIceCandidate(message.payload);
    }
  }

  close() {
    this.unsubscribe?.();
    this.peer.close();
  }
}
