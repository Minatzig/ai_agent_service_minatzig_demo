# debug.py
import os
from dotenv import load_dotenv

print("1. Loading .env file...")
load_dotenv()

print("2. Checking for API key...")
key = os.getenv("OPENROUTER_API_KEY")

if key:
    print(f"✅ Key found: {key[:20]}...")
else:
    print("❌ No key found!")
    print("\nChecking .env file contents:")
    try:
        with open('.env', 'r') as f:
            print(f.read())
    except FileNotFoundError:
        print("❌ .env file doesn't exist!")

print("\n3. Testing API call...")
if key:
    from langchain_openai import ChatOpenAI
    
    llm = ChatOpenAI(
        model="anthropic/claude-3.5-sonnet",
        base_url="https://openrouter.ai/api/v1",
        api_key=key,
    )
    
    try:
        response = llm.invoke("Say hello")
        print(f"✅ API works! Response: {response.content}")
    except Exception as e:
        print(f"❌ API error: {e}")