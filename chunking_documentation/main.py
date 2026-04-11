"""
Complete Chunking Pipeline Orchestrator with Progress Tracking

Runs all processing steps in sequence with resumable progress:
1. image_converter.py    - Extract images from PDF/DOCX → output/01_images_converted/
2. markdown_converter.py - Convert to markdown → output/02_markdown/
3. chunker.py           - Split into chunks → output/03_chunking/
4. embed_and_insert.py  - Generate embeddings & insert → database (final)

Features:
- Creates output subfolders for each stage
- Tracks progress in progress.json
- Automatically resumes from last incomplete stage if interrupted
- Saves intermediate results at each step

Usage:
    python main.py

Directory structure:
    input_output/
    ├── input/              (source PDF/DOCX files)
    ├── output/
    │   ├── 01_images_converted/  (stage 1 results)
    │   ├── 02_markdown/          (stage 2 results)
    │   ├── 03_chunking/          (stage 3 results)
    │   ├── progress.json         (progress tracking)
    │   └── processing.log        (execution log)
"""

import subprocess
import sys
import os
import json
import shutil
from pathlib import Path
from datetime import datetime
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

def print_warning(text):
    print(f"{Colors.WARNING}{Colors.BOLD}⚠️  {text}{Colors.ENDC}")


class ProgressTracker:
    """Track and persist pipeline progress."""
    
    def __init__(self, output_folder: Path):
        self.output_folder = output_folder
        self.progress_file = output_folder / "progress.json"
        self.log_file = output_folder / "processing.log"
        self.data = self._load_progress()
    
    def _load_progress(self) -> dict:
        """Load progress from file or create new."""
        if self.progress_file.exists():
            try:
                with open(self.progress_file) as f:
                    return json.load(f)
            except Exception as e:
                print_warning(f"Could not load progress file: {e}")
        
        return {
            "started_at": datetime.now().isoformat(),
            "last_updated": datetime.now().isoformat(),
            "current_stage": 0,
            "stages": {
                "image_conversion": {"completed": False, "started": False},
                "markdown_conversion": {"completed": False, "started": False},
                "chunking": {"completed": False, "started": False},
                "embedding": {"completed": False, "started": False}
            }
        }
    
    def save(self):
        """Save progress to file."""
        self.data["last_updated"] = datetime.now().isoformat()
        try:
            with open(self.progress_file, 'w') as f:
                json.dump(self.data, f, indent=2)
        except Exception as e:
            print_error(f"Failed to save progress: {e}")
    
    def start_stage(self, stage_name: str):
        """Mark a stage as started."""
        if stage_name in self.data["stages"]:
            self.data["stages"][stage_name]["started"] = True
            self.save()
    
    def complete_stage(self, stage_name: str):
        """Mark a stage as completed."""
        if stage_name in self.data["stages"]:
            self.data["stages"][stage_name]["completed"] = True
            self.save()
    
    def is_stage_completed(self, stage_name: str) -> bool:
        """Check if a stage is already completed."""
        return self.data["stages"].get(stage_name, {}).get("completed", False)
    
    def log(self, message: str):
        """Log a message."""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_message = f"[{timestamp}] {message}"
        print(log_message)
        try:
            with open(self.log_file, 'a') as f:
                f.write(log_message + "\n")
        except Exception as e:
            print_warning(f"Could not write to log: {e}")


def run_script(
    script_name: str,
    step_num: int,
    description: str,
    input_folder: Path,
    output_folder: Path,
    stage_name: str,
    progress: ProgressTracker
) -> bool:
    """Run a processing script with stage-specific folders."""
    
    # Skip if already completed
    if progress.is_stage_completed(stage_name):
        print_info(f"Stage already completed, skipping...")
        return True
    
    progress.start_stage(stage_name)
    print_step(step_num, description)
    progress.log(f"Starting stage: {stage_name}")
    
    # Create stage-specific output folder
    stage_output = output_folder / f"{step_num:02d}_{stage_name.replace('_', '-')}"
    stage_output.mkdir(parents=True, exist_ok=True)
    
    script_path = Path(__file__).parent / script_name
    
    if not script_path.exists():
        print_error(f"Script not found: {script_path}")
        return False
    
    # Set environment variables for this stage
    env = os.environ.copy()
    env["CHUNKER_INPUT_FOLDER"] = str(input_folder)
    env["CHUNKER_OUTPUT_FOLDER"] = str(stage_output)
    
    try:
        progress.log(f"Running: {script_name}")
        print_info(f"Input: {input_folder}")
        print_info(f"Output: {stage_output}")
        
        result = subprocess.run(
            [sys.executable, str(script_path)],
            cwd=Path(__file__).parent,
            env=env,
            capture_output=False
        )
        
        if result.returncode != 0:
            print_error(f"{script_name} failed with exit code {result.returncode}")
            progress.log(f"ERROR: {script_name} failed with code {result.returncode}")
            return False
        
        print_success(f"{script_name} completed successfully")
        progress.complete_stage(stage_name)
        progress.log(f"Completed stage: {stage_name}")
        return True
        
    except Exception as e:
        print_error(f"Error running {script_name}: {e}")
        progress.log(f"ERROR: {str(e)}")
        return False


def setup_folders(base_folder: Path) -> tuple:
    """Setup input/output folder structure."""
    input_folder = base_folder / "input"
    output_folder = base_folder / "output"
    
    # Create folders if they don't exist
    input_folder.mkdir(parents=True, exist_ok=True)
    output_folder.mkdir(parents=True, exist_ok=True)
    
    return input_folder, output_folder


def prepare_next_stage_input(
    current_output: Path,
    next_input: Path,
    file_pattern: str = "*"
) -> int:
    """
    Copy output from current stage to be input for next stage.
    Returns the number of files copied.
    """
    files_copied = 0
    for file in current_output.glob(file_pattern):
        if file.is_file():
            dest = next_input / file.name
            shutil.copy2(file, dest)
            files_copied += 1
    return files_copied


def main():
    print_header("🚀 Complete Chunking Pipeline with Progress Tracking")
    print_info("Converting documents → chunks → embeddings → database")
    
    # Get base folder from .env or use default
    base_folder = Path(os.getenv("PIPELINE_BASE_FOLDER", "./input_output"))
    
    # Setup folder structure
    input_folder, output_folder = setup_folders(base_folder)
    
    print_info(f"Base folder: {base_folder}")
    print_info(f"Input folder: {input_folder}")
    print_info(f"Output folder: {output_folder}")
    
    # Initialize progress tracker
    progress = ProgressTracker(output_folder)
    progress.log("Pipeline started")
    
    # Check for input files
    pdf_count = len(list(input_folder.glob("*.pdf")))
    docx_count = len(list(input_folder.glob("*.docx")))
    md_count = len(list(input_folder.glob("*.md")))
    
    print_info(f"Files to process: {pdf_count} PDFs, {docx_count} DOCX, {md_count} Markdown")
    
    if pdf_count == 0 and docx_count == 0 and md_count == 0:
        print_error("No PDF, DOCX, or Markdown files found in input folder")
        progress.log("ERROR: No input files found")
        sys.exit(1)
    
    print_header("Running Pipeline with Progress Tracking")
    
    # Define pipeline stages
    stages = [
        {
            "script": "image_converter.py",
            "step": 1,
            "description": "Converting images to descriptions",
            "stage_name": "image_conversion",
            "input_pattern": "*.pdf *.docx",
            "output_pattern": "*.pdf *.docx"
        },
        {
            "script": "markdown_converter.py",
            "step": 2,
            "description": "Converting documents to markdown",
            "stage_name": "markdown_conversion",
            "input_pattern": "*.pdf *.docx",
            "output_pattern": "*.md"
        },
        {
            "script": "chunker.py",
            "step": 3,
            "description": "Splitting into logical chunks",
            "stage_name": "chunking",
            "input_pattern": "*.md",
            "output_pattern": "*.json"
        },
        {
            "script": "embed_and_insert.py",
            "step": 4,
            "description": "Generating embeddings and inserting to database",
            "stage_name": "embedding",
            "input_pattern": "*.json",
            "output_pattern": "database"
        }
    ]
    
    # Run pipeline stages
    current_input = input_folder
    
    for i, stage in enumerate(stages):
        # Prepare input from previous stage (except first stage)
        if i > 0:
            prev_stage = stages[i - 1]
            prev_output = output_folder / f"{prev_stage['step']:02d}_{prev_stage['stage_name'].replace('_', '-')}"
            
            if prev_output.exists():
                files_copied = prepare_next_stage_input(
                    prev_output,
                    current_input
                )
                progress.log(f"Copied {files_copied} files from {prev_stage['stage_name']}")
        
        # Run the stage
        success = run_script(
            stage["script"],
            stage["step"],
            stage["description"],
            current_input,
            output_folder,
            stage["stage_name"],
            progress
        )
        
        if not success:
            print_error(f"Pipeline failed at stage: {stage['stage_name']}")
            progress.log(f"Pipeline failed at stage: {stage['stage_name']}")
            print_warning("You can resume from here by running the pipeline again")
            sys.exit(1)
    
    # Success!
    print_header("✅ Pipeline Complete!")
    progress.log("Pipeline completed successfully")
    
    # Show output summary
    print_info("Processing complete. Results saved in:")
    print(f"  📁 {output_folder}")
    print(f"\n  Stage outputs:")
    print(f"    01_images-converted/     - Images converted to descriptions")
    print(f"    02_markdown/             - Markdown files")
    print(f"    03_chunking/             - JSON chunks with embeddings")
    print(f"    progress.json            - Progress tracking")
    print(f"    processing.log           - Detailed log")
    
    # Count final chunks
    chunks_file = output_folder / "03_chunking" / "all_chunks.json"
    if chunks_file.exists():
        try:
            with open(chunks_file) as f:
                chunks = json.load(f)
            print(f"\n  📊 Total chunks created: {len(chunks)}")
        except:
            pass
    
    print(f"\n✨ All documents have been:")
    print(f"  ✓ Images converted to descriptions")
    print(f"  ✓ Converted to markdown")
    print(f"  ✓ Split into logical chunks")
    print(f"  ✓ Embedded and inserted into database")
    print(f"\n🎯 Ready for RAG system!")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print_error("\nPipeline interrupted by user")
        print_info("You can resume by running: python main.py")
        sys.exit(1)
    except Exception as e:
        print_error(f"Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
