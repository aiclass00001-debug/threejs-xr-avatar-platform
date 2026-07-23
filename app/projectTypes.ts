export type ProjectAssetSlot = "vrm" | "animation" | "audio" | "target" | "targetData";

export type PublishedAsset = {
  name: string;
  originalName: string;
  contentType: string;
  size: number;
  url: string;
  chunks?: Array<{
    partNumber: number;
    size: number;
    url: string;
  }>;
};

export type PublishedProject = {
  id: string;
  version: 1;
  name: string;
  createdAt: string;
  launchCode?: string;
  assets: Partial<Record<ProjectAssetSlot, PublishedAsset>>;
};

export type UploadAssetInput = {
  originalName: string;
  contentType: string;
  size: number;
};

export type MultipartPart = {
  partNumber: number;
  etag: string;
};

export type UploadSession = UploadAssetInput & {
  name: string;
  uploadId: string;
  parts: MultipartPart[];
};
