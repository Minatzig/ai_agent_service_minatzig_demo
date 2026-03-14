"""
Complete Chunking Pipeline Orchestrator

Runs all processing steps in sequence:
1. image_converter.py    - Extract images from PDF/DOCX, convert to descriptions
2. markdown_converter.py - Convert cleaned PDF/DOCX to markdown
3. chunker.py           - Split markdown into logical chunks
4. embed_and_insert.py  - Generate embeddings and insert into database

Usage:
    python main.py

This will process all files from CHUNKER_INPUT_FOLDER and prepare them for the database.
"""

import subprocess
import sys
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Colors for terminal output
class Colors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

def print_header(text):
    print(f"\n{Colors.HEADER}{Colors.BOLD}{'='*60}{Colors.ENDC}")
    print(f"{Colors.HEADER}{Colors.BOLD}{text}{Colors.ENDC}")
    print(f"{Colors.HEADER}{Colors.BOLD}{'='*60}{Colors.ENDC}\n")

def print_step(step_num, text):
    print(f"{Colors.OKBLUE}{Colors.BOLD}Step {step_num}: {text}{Colors.ENDC}")

def print_success(text):
    print(f"{Colors.OKGREEN}{Colors.BOLD}✅ {text}{Colors.ENDC}")

def print_error(text):
    print(f"{Colors.FAIL}{Colors.BOLD}❌ {text}{Colors.ENDC}")

def print_info(text):
    print(f"{Colors.OKCYAN}ℹ️  {text}{Colors.ENDC}")

def run_script(script_name, step_num, description):
    """Run a processing script and handle errors."""
    print_step(step_num, description)
    
    script_path = Path(__file__).parent / script_name
    
    if not script_path.exists():
        print_error(f"Script not found: {script_path}")
        return False
    
    try:
        result = subprocess.run(
            [sys.executable, str(script_path)],
            cwd=Path(__file__).parent,
            capture_output=False
        )
        
        if result.returncode != 0:
            print_error(f"{script_name} failed with exit code {result.returncode}")
            return False
        
        print_success(f"{script_name} completed successfully")
        return True
        
    except Exception as e:
        print_error(f"Error running {script_name}: {e}")
        return False

def verify_environment():
    """Check that all required environment variables are set."""
    required_vars = [
        "GEMINI_API_KEY",
        "CHUNKER_INPUT_FOLDER",
        "CHUNKER_OUTPUT_FOLDER",
        "DB_HOST",
        "DB_PORT",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD"
    ]
    
    missing = []
    for var in required_vars:
        if not os.getenv(var):
            missing.append(var)
    
    if missing:
        print_error("Missing environment variables:")
        for var in missing:
            print(f"  - {var}")
        return False
    
    return True

def main():
    print_header("🚀 Complete Chunking Pipeline")
    print_info("Converting documents → chunks → embeddings → database")
    
    # Verify environment
    print_step(0, "Verifying environment")
    if not verify_environment():
        print_error("Environment verification failed. Please check your .env file.")
        sys.exit(1)
    print_success("Environment verified")
    
    # Get input folder info
    input_folder = Path(os.getenv("CHUNKER_INPUT_FOLDER"))
    output_folder = Path(os.getenv("CHUNKER_OUTPUT_FOLDER"))
    
    pdf_count = len(list(input_folder.glob("*.pdf")))
    docx_count = len(list(input_folder.glob("*.docx")))
    
    print_info(f"Input folder: {input_folder}")
    print_info(f"Output folder: {output_folder}")
    print_info(f"Files to process: {pdf_count} PDFs, {docx_count} DOCX files")
    
    if pdf_count == 0 and docx_count == 0:
        print_error("No PDF or DOCX files found in input folder")
        sys.exit(1)
    
    # Run pipeline steps
    print_header("Running Pipeline")
    
    steps = [
        ("image_converter.py", 1, "Converting images to descriptions"),
        ("markdown_converter.py", 2, "Converting documents to markdown"),
        ("chunker.py", 3, "Splitting into logical chunks"),
        ("embed_and_insert.py", 4, "Generating embeddings and inserting to database")
    ]
    
    for script, step_num, description in steps:
        if not run_script(script, step_num, description):
            print_error(f"Pipeline failed at step {step_num}")
            sys.exit(1)
    
    # Success!
    print_header("✅ Pipeline Complete!")
    
    # Show output summary
    print_info("Processing complete. Results:")
    print(f"  📁 Output folder: {output_folder}")
    
    # Count output files
    chunks_file = output_folder / "all_chunks.json"
    if chunks_file.exists():
        import json
        try:
            with open(chunks_file) as f:
                chunks = json.load(f)
            print(f"  📊 Total chunks created: {len(chunks)}")
        except:
            pass
    
    print(f"\n✨ All documents have been:")
    print(f"  ✓ Images converted to descriptions")
    print(f"  ✓ Converted to markdown")
    print(f"  ✓ Split into chunks")
    print(f"  ✓ Embedded and inserted into database")
    print(f"\n🎯 Ready for RAG system!")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print_error("\nPipeline interrupted by user")
        sys.exit(1)
    except Exception as e:
        print_error(f"Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
