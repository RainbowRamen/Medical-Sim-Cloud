import os
import random
import string
from flask import Flask, render_template, request, redirect, url_for
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sim_secret_123'

# FIX 1: Set to 'eventlet' to match your Render Gunicorn command
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# --- SERVER STATE MEMORY ---
rooms_data = {}

# Helper to create 4-character room codes (e.g., A7B2)
def generate_room_code():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))

# --- ROUTES ---

@app.route('/')
def index():
    # If someone hits the base URL, send them to a new control room
    return redirect(url_for('controller', room=generate_room_code()))

@app.route('/control')
def controller():
    room = request.args.get('room')
    # FIX 2: If there is no ?room= in the URL, generate one and redirect
    if not room:
        return redirect(url_for('controller', room=generate_room_code()))
    return render_template('control.html')

@app.route('/monitor')
def monitor():
    room = request.args.get('room')
    if not room:
        return "<h1>Error: No Room Code</h1><p>Please scan the QR code from the Controller.</p>"
    return render_template('monitor.html')

# --- SOCKET LOGIC ---

@socketio.on('join')
def on_join(data):
    room = data.get('room')
    if room:
        join_room(room)
        print(f"Device joined room: {room}")
        
        # Initialize room data if it's a new session
        if room not in rooms_data:
            rooms_data[room] = {
                'hr': 60, 'hr_conn': False, 'spo2': 98, 'spo2_conn': False,
                'sys': 120, 'dia': 80, 'bp_conn': False, 'temp': 36.8,
                'signal_quality': 'normal'
            }
        
        # Send current room state to the joining device
        emit('update_monitor', {'type': 'vitals', **rooms_data[room]}, room=room)

@socketio.on('update_vitals')
def handle_vitals(data):
    room = data.get('room')
    if not room: 
        return
    
    # Update server memory for this room
    if room in rooms_data:
        if data['type'] == 'vitals':
            rooms_data[room].update({
                'hr': data['hr'], 'spo2': data['spo2'],
                'hr_conn': data['hr_conn'], 'spo2_conn': data['spo2_conn'],
                'signal_quality': data.get('signal_quality', 'normal')
            })
        elif data['type'] == 'set_target_bp':
            rooms_data[room].update({
                'sys': data['sys'], 'dia': data['dia'], 'bp_conn': data['bp_conn']
            })
        elif data['type'] == 'push_temp':
            rooms_data[room].update({'temp': data['temp']})

    # Forward the update to everyone else in that specific room
    emit('update_monitor', data, room=room)

@socketio.on('monitor_powered_on')
def handle_boot(data):
    room = data.get('room')
    emit('sync_controller_power', {'status': 'on'}, room=room)

@socketio.on('system_shutdown')
def handle_shutdown(data):
    # Only works if hosted on a Raspberry Pi locally
    if os.path.exists('/proc/version'): 
        os.system('sudo shutdown -h now')

if __name__ == '__main__':
    # Use the port Render assigns, default to 5000
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port)
