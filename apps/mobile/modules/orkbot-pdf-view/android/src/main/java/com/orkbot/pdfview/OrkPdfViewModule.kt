package com.orkbot.pdfview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** A PDF drawn with the system PdfRenderer; Android's WebView cannot show one. */
class OrkPdfViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OrkPdfView")

    View(OrkPdfView::class) {
      Events("onLoadError")
      Prop("uri") { view: OrkPdfView, uri: String -> view.load(uri) }
      OnViewDestroys { view: OrkPdfView -> view.release() }
    }
  }
}
