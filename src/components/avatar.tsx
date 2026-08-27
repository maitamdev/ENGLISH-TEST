type AvatarProps = { name: string; src?: string; size?: number; speaking?: boolean };

export function Avatar({ name, src, size = 52, speaking = false }: AvatarProps) {
  const initials = name.split(" ").map((part) => part[0]).slice(-2).join("");
  return (
    <div className={`avatar ${speaking ? "speaking" : ""}`} style={{ width: size, height: size }} aria-label={`${name}${speaking ? " is speaking" : ""}`}>
      {src ? <span role="img" aria-label="" style={{ width: "100%", height: "100%", backgroundImage: `url(${src})`, backgroundSize: "cover", backgroundPosition: "center" }} /> : <strong>{initials}</strong>}
    </div>
  );
}
