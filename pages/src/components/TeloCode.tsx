import { Check, Copy } from "lucide-react";
import { useState } from "react";

interface TeloCodeProps {
  html: string;
  code: string;
}

export default function TeloCode({ html, code }: TeloCodeProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="teloCode">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <button type="button" className="teloCodeCopy" aria-label="Copy code" onClick={copy}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}
