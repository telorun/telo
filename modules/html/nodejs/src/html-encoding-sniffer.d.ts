declare module "html-encoding-sniffer" {
  export default function sniffHtmlEncoding(
    bytes: Uint8Array,
    options?: {
      xml?: boolean;
      transportLayerEncodingLabel?: string;
      defaultEncoding?: string;
      maxPrescanBytes?: number;
    },
  ): string;
}
