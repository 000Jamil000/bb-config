import { SaxesParser } from "saxes";

export const ICON_FILES = [".bb/icon.png", ".bb/icon.svg", "favicon.png", "favicon.svg", "favicon.ico"];
export const MAX_BYTES = 256 * 1024;

// Keep SVG vector, but only allow passive, self-contained graphics.
export function imageType(bytes: Buffer): "svg" | "png" {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Image must be 1–256 KiB");
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (bytes.length < 45 || bytes.toString("ascii", 12, 16) !== "IHDR" ||
        !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) ||
        bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096 ||
        bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") {
      throw new Error("Invalid PNG or image dimensions exceed 4096px");
    }
    return "png";
  }
  const tags = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "clipPath", "mask", "linearGradient", "radialGradient", "stop", "title", "desc", "use"]);
  const attrs = new Set(["xmlns", "xmlns:xlink", "id", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "opacity", "transform", "clip-path", "clip-rule", "mask", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "fx", "fy", "href", "xlink:href", "preserveAspectRatio", "version"]);
  const parser = new SaxesParser({ xmlns: true });
  let count = 0;
  parser.on("doctype", () => { throw new Error("SVG DOCTYPE is forbidden"); });
  parser.on("processinginstruction", () => { throw new Error("SVG processing instructions are forbidden"); });
  parser.on("opentag", tag => {
    if ((!count++ && tag.name !== "svg") || !tags.has(tag.name) ||
        tag.uri !== "http://www.w3.org/2000/svg") throw new Error("Unsupported SVG element");
    for (const attr of Object.values(tag.attributes)) {
      if (!attrs.has(attr.name)) throw new Error(`Unsupported SVG attribute: ${attr.name}`);
      if (attr.name === "href" || attr.name === "xlink:href") {
        if (!/^#[\w.-]+$/.test(attr.value)) throw new Error("External SVG references are forbidden");
      }
      if (/url\s*\(/i.test(attr.value) && !/^url\(#[\w.-]+\)$/.test(attr.value)) {
        throw new Error("External SVG resources are forbidden");
      }
    }
  });
  parser.write(bytes.toString("utf8")).close();
  if (!count) throw new Error("Expected PNG or SVG");
  return "svg";
}
