/**
 * postject ships no types. Only the one call `telo package` makes on a darwin
 * carrier is declared — the same tool the standalone build drives, reached here
 * as a library rather than as a CLI.
 */
declare module "postject" {
  export function inject(
    filename: string,
    resourceName: string,
    resourceData: Buffer,
    options?: {
      machoSegmentName?: string;
      overwrite?: boolean;
      sentinelFuse?: string;
    },
  ): Promise<void>;
}
