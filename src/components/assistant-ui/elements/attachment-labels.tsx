"use client"

import { createContext, useContext } from "react"

export type AttachmentLabels = {
  add: string
  remove: string
  preview: string
  image: string
  audio: string
  video: string
  document: string
  file: string
  uploading: string
  uploadFailed: string
}

export const DEFAULT_ATTACHMENT_LABELS: AttachmentLabels = {
  add: "Add attachment",
  remove: "Remove attachment",
  preview: "Attachment preview",
  image: "Image attachment",
  audio: "Audio attachment",
  video: "Video attachment",
  document: "Document attachment",
  file: "File attachment",
  uploading: "Uploading",
  uploadFailed: "Upload failed",
}

export const AttachmentLabelsContext = createContext<AttachmentLabels>(
  DEFAULT_ATTACHMENT_LABELS
)

export function useAttachmentLabels() {
  return useContext(AttachmentLabelsContext)
}
