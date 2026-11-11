/**
 * pngjs ships no types. Only the synchronous decode and encode the desktop icon
 * builders use are declared.
 */
declare module "pngjs" {
  export class PNG {
    constructor(options: { width: number; height: number });
    width: number;
    height: number;
    /** RGBA, 8 bits a channel, rows top to bottom. */
    data: Buffer;
    static sync: {
      read(buffer: Buffer): PNG;
      write(png: PNG, options?: { colorType?: number }): Buffer;
    };
  }
}
