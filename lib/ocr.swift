// On-device OCR using macOS Vision. Usage: ocr img1.png img2.png ... -> JSON array of strings
import Foundation
import Vision
import AppKit

var out: [String] = []
for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { out.append(""); continue }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  if #available(macOS 13.0, *) { req.automaticallyDetectsLanguage = true }
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  var text = ""
  var prev: CGRect? = nil
  for obs in req.results ?? [] {
    guard let s = obs.topCandidates(1).first?.string else { continue }
    let box = obs.boundingBox
    if let p = prev {
      // big vertical gap => new paragraph
      let gap = p.minY - box.maxY
      text += gap > box.height * 0.9 ? "\n\n" : "\n"
    }
    text += s
    prev = box
  }
  out.append(text)
}
let data = try! JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
