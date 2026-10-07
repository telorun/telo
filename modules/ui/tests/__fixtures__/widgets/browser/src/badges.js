import "./badges.css";

export function StatusPill(props) {
  return props.done ? "done" : "open";
}
