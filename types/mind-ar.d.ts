declare module "mind-ar/dist/mindar-image-three.prod.js" {
  export class MindARThree {
    constructor(options: Record<string, unknown>);
  }
}

declare module "mind-ar/src/image-target/compiler.js" {
  export class Compiler {
    compileImageTargets(images: CanvasImageSource[], progress: (percent: number) => void): Promise<unknown>;
    exportData(): Uint8Array;
  }
}
