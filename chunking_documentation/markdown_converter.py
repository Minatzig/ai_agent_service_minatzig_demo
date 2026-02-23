import os
from pathlib import Path
import pymupdf4llm
import docx
from markdownify import markdownify as md

INPUT_FOLDER  = "/Users/adinisman/Downloads/dynatech/input_docs"   # ← PUT YOUR INPUT PATH HERE
OUTPUT_FOLDER = "/Users/adinisman/Downloads/dynatech/output_docs"  # same as input but now as markdown

def convert_pdf(filepath: Path) -> str:
    """Convert PDF to Markdown using pymupdf4llm (preserves structure well)."""
    return pymupdf4llm.to_markdown(str(filepath))

def convert_docx(filepath: Path) -> str:
    """Convert Word doc to Markdown."""
    doc = docx.Document(str(filepath))
    full_text = "\n\n".join([para.text for para in doc.paragraphs if para.text.strip()])
    return md(full_text)

if __name__ == "__main__":
    input_path = Path(INPUT_FOLDER)

    pdf_files  = list(input_path.glob("*.pdf"))
    docx_files = list(input_path.glob("*.docx"))

    if not pdf_files and not docx_files:
        print("⚠️  No PDF or DOCX files found.")
        exit()

    for pdf in pdf_files:
        print(f"📄 Converting PDF: {pdf.name}")
        try:
            markdown = convert_pdf(pdf)
            out_path = input_path / f"{pdf.stem}.md"
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(markdown)
            print(f"  ✅ Saved as {out_path.name}")
        except Exception as e:
            print(f"  ⚠️  Failed: {e}")

    for docx_file in docx_files:
        print(f"📄 Converting DOCX: {docx_file.name}")
        try:
            markdown = convert_docx(docx_file)
            out_path = input_path / f"{docx_file.stem}.md"
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(markdown)
            print(f"  ✅ Saved as {out_path.name}")
        except Exception as e:
            print(f"  ⚠️  Failed: {e}")

    print("\n✅ All conversions done! You can now run chunker.py")