import os
import random
import string
from flask import Flask, render_template, request, redirect, url_for
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sim_secret_123'

# Standardizing on eventlet for Render
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# --- SERVER STATE MEMORY ---
rooms_data = {}

def generate_room_code():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))

# --- ROUTES ---

@app.route('/')
def index():
    # Automatically sends the user to a unique control room
    return redirect(url_for('controller', room=generate_room_code()))

@app.route('/control')
def controller():
    room = request.args.get('room')
    if not room:
        return redirect(url_for('controller', room=generate_room_code()))
    # NOTE: Ensure your file is named 'controller.html' in the templates folder
    return render_template('controller.html')

@app.route('/monitor')
def monitor():
    room = request.args.get('room')
    if not room:
        return "<h1>Room Code Required</h1><p>Please use the link from your controller.</p>"
    return render_template('monitor.html')

# --- SOCKET LOGIC ---

@socketio.on('join')
def on_join(data):
    room = data.get('room')
    if room:
        join_room(room)
        if room not in rooms_data:
            rooms_data[room] = {
                'hr': 60, 'hr_conn': False, 'spo2': 98, 'spo2_conn': False,
                'sys': 120, 'dia': 80, 'bp_conn': False, 'temp': 36.8,
                'signal_quality': 'normal'
            }
        emit('update_monitor', {'type': 'vitals', **rooms_data[room]}, room=room)

@socketio.on('update_vitals')
def handle_vitals(data):
    room = data.get('room')
    if room and room in rooms_data:
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
        
        emit('update_monitor', data, room=room)

@socketio.on('system_shutdown')
def handle_shutdown(data):
    room = data.get('room')
    # Signal the monitor in that room to shut down
    emit('system_shutdown_trigger', {}, room=room)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port)
