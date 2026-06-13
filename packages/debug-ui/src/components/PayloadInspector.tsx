import { blobDimensions, collectBlobs, formatBytes, type FoundBlob } from "../media.js";
import { isWireRef } from "../wire.js";

export interface PayloadInspectorProps {
  value: unknown;
  /** Turns a relative blob path (`blobs/<id>`) into a fetchable URL against the
   *  producer origin. */
  resolveUrl: (rel: string) => string;
}

/** Pretty-prints an event payload. Binary lives in the blob store, not the
 *  payload — any `{ $blob }` pointers are rendered as media (images inline, other
 *  files as download links) above the JSON, which itself only carries the small
 *  pointer descriptors. */
export function PayloadInspector({ value, resolveUrl }: PayloadInspectorProps) {
  if (value === undefined) {
    return <div className="tdbg-payload tdbg-muted">(no payload)</div>;
  }
  if (isWireRef(value)) {
    return (
      <div className="tdbg-payload">
        <span className="tdbg-ref">
          {value.kind} <span className="tdbg-muted">·</span> {value.name}
        </span>
      </div>
    );
  }

  const blobs = collectBlobs(value);
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }

  return (
    <div className="tdbg-payload-wrap">
      {blobs.length > 0 && (
        <div className="tdbg-media">
          {blobs.map((b, i) => (
            <BlobView key={i} found={b} resolveUrl={resolveUrl} />
          ))}
        </div>
      )}
      <pre className="tdbg-payload">{text}</pre>
    </div>
  );
}

function BlobView({ found, resolveUrl }: { found: FoundBlob; resolveUrl: (rel: string) => string }) {
  const { path, blob, parent } = found;
  const src = resolveUrl(blob.$blob);
  const dims = blobDimensions(parent);
  const caption = [path, blob.mediaType, formatBytes(blob.byteLength), dims].filter(Boolean).join(" · ");

  return (
    <figure className="tdbg-blob">
      {blob.mediaType.startsWith("image/") ? (
        <a href={src} target="_blank" rel="noreferrer">
          <img className="tdbg-blob-img" src={src} alt={path} loading="lazy" />
        </a>
      ) : (
        <a className="tdbg-blob-file" href={src} target="_blank" rel="noreferrer" download>
          ⬇ {blob.mediaType}
        </a>
      )}
      <figcaption className="tdbg-blob-cap">{caption}</figcaption>
    </figure>
  );
}
