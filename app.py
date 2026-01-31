import os
import threading
import time
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sim_secret_123'

# Force eventlet or gevent for better WebSocket performance on Render
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# --- SERVER STATE MEMORY ---
# We now store vitals per room so multiple people can use the app at once
rooms_data = {}

@app.route('/')
@app.route('/monitor')
def monitor():
    return render_template('monitor.html')

@app.route('/control')
def controller():
    return render_template('controller.html')

# --- ROOM LOGIC ---
@socketio.on('join')
def on_join(data):
    room = data['room']
    join_room(room)
    print(f"Device joined room: {room}")
    
    # Initialize room data if it doesn't exist
    if room not in rooms_data:
        rooms_data[room] = {
            'hr': 60, 'hr_conn': False, 'spo2': 98, 'spo2_conn': False,
            'sys': 120, 'dia': 80, 'bp_conn': False, 'temp': 36.8,
            'signal_quality': 'normal'
        }
    
    # Send current state to the device that just joined
    emit('update_monitor', {'type': 'vitals', **rooms_data[room]}, room=room)

@socketio.on('update_vitals')
def handle_vitals(data):
    room = data.get('room')
    if not room: return
    
    # Update the server's memory for this specific room
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

    # Send ONLY to devices in this room
    emit('update_monitor', data, room=room)

@socketio.on('monitor_powered_on')
def handle_boot(data):
    room = data.get('room')
    emit('sync_controller_power', {'status': 'on'}, room=room)

@socketio.on('system_shutdown')
def handle_shutdown(data):
    # Security: Only allow shutdown if running on a Raspberry Pi locally
    if os.path.exists('/proc/version'): 
        os.system('sudo shutdown -h now')

if __name__ == '__main__':
    # Render uses the PORT environment variable
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port)

