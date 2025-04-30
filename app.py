from fastapi import FastAPI, WebSocket, Request, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import uvicorn
import os
import uuid
import tempfile
import base64
import io
import json
import asyncio
import logging
from datetime import datetime
from typing import Dict, List, Any, Optional
from pydantic import BaseModel
from openai import OpenAI
from elevenlabs.client import ElevenLabs
from elevenlabs import stream
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# API keys from environment variables
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")  # Default voice ID

# Context for the assistant
ASSISTANT_CONTEXT = """
You’re a polite call assistant for Panorama Hospital, handling OPD or emergency calls.  Ask if it's OPD or emergency. For OPD: ask if it’s their first visit, doctor/department, preferred time. For emergencies: get address/contact. Confirm slot. End warmly. Never repeat greeting.

"""

# Initialize API clients
openai_client = OpenAI(api_key=OPENAI_API_KEY)
eleven_labs_client = ElevenLabs(api_key=ELEVENLABS_API_KEY)

# Temporary directory for audio files
TEMP_DIRECTORY = tempfile.gettempdir()

# Data models
class Message(BaseModel):
    role: str
    content: str

class Conversation(BaseModel):
    id: str
    messages: List[Message] = []
    created_at: str = datetime.now().isoformat()
    active: bool = False
    first_message_sent: bool = False  # Track if this is the first message
    last_user_message: Optional[str] = None  # Track the last user message to prevent duplicates

# In-memory storage for conversations
conversations: Dict[str, Conversation] = {}

# Create FastAPI app
app = FastAPI(title="Voice Assistant API")

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Initialize templates
templates = Jinja2Templates(directory="templates")

# Function to transcribe audio using OpenAI Whisper
async def transcribe_audio(audio_file_path: str) -> str:
    try:
        with open(audio_file_path, "rb") as audio_file:
            transcription = openai_client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                language="en",  # Force English language
                prompt="This is a conversation about medical appointments at a hospital."  # Context helps with accuracy
            )
        return transcription.text
    except Exception as e:
        logger.error(f"Transcription error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

async def get_ai_response(conversation_id: str, user_input: str) -> str:
    try:
        user_input = user_input.strip()

        if conversation_id not in conversations:
            conversations[conversation_id] = Conversation(id=conversation_id)

        conversation = conversations[conversation_id]

        # Prevent repeated user messages (even if case differs)
        if conversation.last_user_message and user_input.lower() == conversation.last_user_message.lower():
            logger.warning(f"Duplicate message detected: {user_input}")
            if conversation.messages and conversation.messages[-1].role == "assistant":
                return conversation.messages[-1].content

        conversation.last_user_message = user_input
        conversation.messages.append(Message(role="user", content=user_input))

        # Force system behavior with clear anti-hallucination prompt
        if not conversation.first_message_sent:
            system_prompt = f"""You are a voice assistant at Panorama Hospital.

            You are currently on a call. Your job is to handle OPD and emergency queries politely.

            Start with a **single greeting**, then ask the required questions based on:
            Please try to end the call by taking the user's details and thanking them for calling.

            {ASSISTANT_CONTEXT}

            NEVER repeat the greeting. NEVER introduce unrelated topics. Keep replies to 2-3 sentences, spoken naturally. Do not mention websites, links, or fictional content.

            Do not repeat the flow if user has already answered.
            """
        else:
            system_prompt = f"""You are continuing a voice call for Panorama Hospital.

            DO NOT repeat greetings or restart the flow. Maintain memory of the conversation so far.

            Use this context:
            Please try to end the call by taking the user's details and thanking them for calling.
            {ASSISTANT_CONTEXT}

            Respond briefly, in a spoken voice. DO NOT hallucinate unrelated text or URLs. DO NOT re-ask questions already answered. End the call gracefully if the user indicates so.
            """

        messages = [{"role": "system", "content": system_prompt}]
        messages += [{"role": msg.role, "content": msg.content} for msg in conversation.messages[-10:]]

        response = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            temperature=0.4,
            max_tokens=800
        )

        ai_response = response.choices[0].message.content.strip()

        # Check if user wants to end the call
        if any(phrase in user_input.lower() for phrase in ["end the call", "that's all", "you can hang up now", "thank you, bye"]):
            ai_response += " Thank you for calling. Take care!"
            conversation.active = False  # End the conversation

        conversation.messages.append(Message(role="assistant", content=ai_response))
        conversation.first_message_sent = True
        return ai_response

    except Exception as e:
        logger.error(f"AI response error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get AI response: {str(e)}")

        
# Function to convert text to speech
async def text_to_speech(text: str) -> str:
    try:
        # Generate a unique filename
        output_filename = os.path.join(TEMP_DIRECTORY, f"tts_{uuid.uuid4()}.mp3")
        
        # Generate audio using ElevenLabs API
        audio_stream = eleven_labs_client.text_to_speech.convert_as_stream(
            text=text,
            voice_id=ELEVENLABS_VOICE_ID,
            model_id="eleven_turbo_v2"
        )
        
        # Collect audio chunks into a buffer
        buffer = io.BytesIO()
        for chunk in audio_stream:
            if isinstance(chunk, bytes):
                buffer.write(chunk)
        
        # Write buffer to file
        with open(output_filename, "wb") as f:
            f.write(buffer.getvalue())
        
        return output_filename
    except Exception as e:
        logger.error(f"Text-to-speech error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Text-to-speech failed: {str(e)}")

# Helper function to clean up temporary files
def cleanup_temp_files(*file_paths):
    for path in file_paths:
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except Exception as e:
                logger.error(f"Error cleaning up file {path}: {str(e)}")

# Route for main page
@app.get("/", response_class=HTMLResponse)
async def get_index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# API endpoint to start a new conversation
@app.post("/api/conversations")
async def create_conversation():
    conversation_id = str(uuid.uuid4())
    conversations[conversation_id] = Conversation(id=conversation_id, active=True, first_message_sent=False)
    logger.info(f"Created new conversation: {conversation_id}")
    return {"conversation_id": conversation_id}

# API endpoint to end a conversation
@app.delete("/api/conversations/{conversation_id}")
async def end_conversation(conversation_id: str):
    if conversation_id in conversations:
        conversations[conversation_id].active = False
        return {"status": "success", "message": "Conversation ended"}
    raise HTTPException(status_code=404, detail="Conversation not found")

# API endpoint to upload audio for transcription
@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...), conversation_id: str = None):
    temp_file_path = None
    audio_path = None
    
    try:
        # Make sure we have a valid conversation ID
        if not conversation_id or conversation_id not in conversations:
            # Create a new conversation if none exists
            if not conversation_id:
                conversation_id = str(uuid.uuid4())
                logger.info(f"Created new conversation in transcribe: {conversation_id}")
            conversations[conversation_id] = Conversation(id=conversation_id, active=True, first_message_sent=False)
        
        # Check if conversation is still active
        if not conversations[conversation_id].active:
            return {"status": "error", "message": "Conversation has ended"}
        
        # Save uploaded file
        temp_file_path = os.path.join(TEMP_DIRECTORY, f"audio_{uuid.uuid4()}.webm")
        with open(temp_file_path, "wb") as buffer:
            buffer.write(await file.read())
        
        # Transcribe the audio
        transcript = await transcribe_audio(temp_file_path)
        
        # If no text was detected
        if not transcript or transcript.strip() == "":
            return {"status": "empty", "message": "No speech detected"}
        
        # Generate AI response
        response = await get_ai_response(conversation_id, transcript)
        
        # Generate speech from response
        audio_path = await text_to_speech(response)
        
        # Get the audio as base64
        with open(audio_path, "rb") as audio_file:
            audio_bytes = audio_file.read()
        audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
        
        return {
            "status": "success",
            "transcript": transcript,
            "response": response,
            "audio": audio_base64,
            "conversation_id": conversation_id
        }
    except Exception as e:
        logger.error(f"Error in transcribe endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Clean up temporary files
        cleanup_temp_files(temp_file_path, audio_path)

# WebSocket endpoint for real-time conversation
@app.websocket("/ws/{conversation_id}")
async def websocket_endpoint(websocket: WebSocket, conversation_id: str):
    await websocket.accept()
    
    if conversation_id not in conversations:
        conversations[conversation_id] = Conversation(id=conversation_id, active=True, first_message_sent=False)
        logger.info(f"Created new conversation in websocket: {conversation_id}")
    
    try:
        while conversations[conversation_id].active:
            temp_file_path = None
            audio_path = None
            
            try:
                # Receive audio chunks from the client
                data = await websocket.receive_bytes()
                
                # Save the received audio
                temp_file_path = os.path.join(TEMP_DIRECTORY, f"ws_audio_{uuid.uuid4()}.webm")
                with open(temp_file_path, "wb") as f:
                    f.write(data)
                
                # Transcribe the audio
                transcript = await transcribe_audio(temp_file_path)
                
                # Skip if no speech was detected
                if not transcript or transcript.strip() == "":
                    await websocket.send_json({"status": "empty"})
                    continue
                
                # Get AI response
                response = await get_ai_response(conversation_id, transcript)
                
                # Generate speech
                audio_path = await text_to_speech(response)
                
                # Get audio as base64
                with open(audio_path, "rb") as audio_file:
                    audio_bytes = audio_file.read()
                audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
                
                # Send response to client
                await websocket.send_json({
                    "status": "success",
                    "transcript": transcript,
                    "response": response,
                    "audio": audio_base64,
                    "conversation_id": conversation_id
                })
                
            except WebSocketDisconnect:
                logger.info(f"WebSocket disconnected for conversation {conversation_id}")
                break
            except Exception as e:
                logger.error(f"WebSocket processing error: {str(e)}")
                try:
                    await websocket.send_json({"status": "error", "message": str(e)})
                except:
                    pass  # Might be disconnected already
            finally:
                # Clean up temporary files
                cleanup_temp_files(temp_file_path, audio_path)
                
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for conversation {conversation_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {str(e)}")
    finally:
        # Mark conversation as inactive on disconnect
        if conversation_id in conversations:
            conversations[conversation_id].active = False


### app.py (modified websocket_endpoint)

# ... all previous imports and code above remain unchanged

@app.websocket("/ws/{conversation_id}")
async def websocket_endpoint(websocket: WebSocket, conversation_id: str):
    await websocket.accept()

    if conversation_id not in conversations:
        conversations[conversation_id] = Conversation(id=conversation_id, active=True, first_message_sent=False)
        logger.info(f"Created new conversation in websocket: {conversation_id}")

    try:
        while conversations[conversation_id].active:
            temp_file_path = None
            audio_path = None

            try:
                # Receive audio chunks from the client
                data = await websocket.receive_bytes()

                # Save the received audio
                temp_file_path = os.path.join(TEMP_DIRECTORY, f"ws_audio_{uuid.uuid4()}.webm")
                with open(temp_file_path, "wb") as f:
                    f.write(data)

                # Transcribe the audio
                transcript = await transcribe_audio(temp_file_path)

                # Skip if no speech was detected
                if not transcript or transcript.strip() == "":
                    await websocket.send_json({"status": "empty"})
                    continue

                # Get AI response
                response = await get_ai_response(conversation_id, transcript)

                # Immediately end the loop if conversation marked inactive
                if not conversations[conversation_id].active:
                    audio_path = await text_to_speech(response)
                    with open(audio_path, "rb") as audio_file:
                        audio_bytes = audio_file.read()
                    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")

                    await websocket.send_json({
                        "status": "ended",
                        "transcript": transcript,
                        "response": response,
                        "audio": audio_base64,
                        "conversation_id": conversation_id
                    })
                    break

                # Generate speech
                audio_path = await text_to_speech(response)

                with open(audio_path, "rb") as audio_file:
                    audio_bytes = audio_file.read()
                audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")

                # Send response to client
                await websocket.send_json({
                    "status": "success",
                    "transcript": transcript,
                    "response": response,
                    "audio": audio_base64,
                    "conversation_id": conversation_id
                })

            except WebSocketDisconnect:
                logger.info(f"WebSocket disconnected for conversation {conversation_id}")
                break
            except Exception as e:
                logger.error(f"WebSocket processing error: {str(e)}")
                try:
                    await websocket.send_json({"status": "error", "message": str(e)})
                except:
                    pass  # Might be disconnected already
            finally:
                cleanup_temp_files(temp_file_path, audio_path)

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for conversation {conversation_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {str(e)}")
    finally:
        if conversation_id in conversations:
            conversations[conversation_id].active = False


# Run the application
if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)