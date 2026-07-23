/**
 * @core/pkg — U5 export surface (unit-of-work.md import 契约):
 * assemble / validatePackage (+ assertPackageDeliverable CLI gate),
 * MetadataFiles / PackageDir / ContractReport + Manifest v1,
 * UploadChecklist and the pure SUMMARY renderer, tolerant frontmatter
 * parser shared by pre-flight and validation.
 */
export * from "./types";
export * from "./frontmatter";
export * from "./summary";
export * from "./assemble";
export * from "./validate";
