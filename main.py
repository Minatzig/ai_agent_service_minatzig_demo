import os
from typing import Annotated, TypedDict
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages

load_dotenv()

# State
class State(TypedDict):
    messages: Annotated[list, add_messages]

# LLM (no tools for now - simpler test)
llm = ChatOpenAI(
    model="anthropic/claude-3.5-sonnet",
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY"),
)

# Node
def chatbot(state: State):
    response = llm.invoke(state["messages"])
    print(f"LLM Response: {response.content}")  # Debug print
    return {"messages": [response]}

# Build graph
graph = StateGraph(State)
graph.add_node("chatbot", chatbot)
graph.add_edge(START, "chatbot")
graph.add_edge("chatbot", END)
app = graph.compile()

# Run
print("Starting...")
result = app.invoke({"messages": [("user", "Say hello!")]})
print(f"Final result: {result}")