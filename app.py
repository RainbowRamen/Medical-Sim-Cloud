import os
import random
import string
from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sim_secret_123'

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# --- SERVER STATE ---
rooms_data = {}

def generate_room_code():
    chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(random.choices(chars, k=4))

# --- ROUTES ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/control')
def controller():
    room = request.args.get('room')
    mode = request.args.get('mode', 'basic')
    if not room:
        return redirect(url_for('index'))
    # Store mode when controller creates room
    if room not in rooms_data:
        rooms_data[room] = create_room(mode)
    else:
        rooms_data[room]['mode'] = mode
    if mode == 'advanced':
        return render_template('controller_adv.html')
    else:
        return render_template('controller.html')

@app.route('/monitor')
def monitor():
    room = request.args.get('room')
    mode = request.args.get('mode', '')
    if not room:
        return "<h1>Room Code Required</h1><p>Please use the link from your controller.</p>"
    # If no mode specified, look it up from room data
    if not mode and room in rooms_data:
        mode = rooms_data[room].get('mode', 'basic')
    elif not mode:
        mode = 'basic'
    if mode == 'advanced':
        return render_template('monitor_adv.html')
    else:
        return render_template('monitor.html')

@app.route('/api/room/<room_code>')
def room_info(room_code):
    """API endpoint for join page to auto-detect room mode"""
    if room_code in rooms_data:
        return jsonify({
            'exists': True,
            'mode': rooms_data[room_code].get('mode', 'basic')
        })
    return jsonify({'exists': False})

# --- HELPERS ---

def create_room(mode='basic'):
    return {
        'mode': mode,
        'hr': 60, 'hr_conn': False,
        'spo2': 98, 'spo2_conn': False,
        'sys': 120, 'dia': 80, 'bp_conn': False,
        'temp': 36.8,
        'signal_quality': 'normal',
        'rhythm': 'nsr'
    }

# --- SOCKET LOGIC ---

@socketio.on('join')
def on_join(data):
    room = data.get('room')
    client_type = data.get('type', 'unknown')
    if room:
        join_room(room)
        if room not in rooms_data:
            rooms_data[room] = create_room()
        emit('update_monitor', {'type': 'joined', 'client': client_type}, room=room)

@socketio.on('update_vitals')
def handle_vitals(data):
    room = data.get('room')
    if not room:
        return
    if room not in rooms_data:
        rooms_data[room] = create_room()

    msg_type = data.get('type', '')

    # --- Basic mode state storage ---
    if msg_type == 'vitals':
        rooms_data[room].update({
            'hr': data.get('hr', rooms_data[room]['hr']),
            'spo2': data.get('spo2', rooms_data[room]['spo2']),
            'hr_conn': data.get('hr_conn', False),
            'spo2_conn': data.get('spo2_conn', False),
            'signal_quality': data.get('signal_quality', 'normal')
        })
    elif msg_type == 'set_target_bp':
        rooms_data[room].update({
            'sys': data.get('sys', 120),
            'dia': data.get('dia', 80),
            'bp_conn': data.get('bp_conn', False)
        })
    elif msg_type == 'push_temp':
        rooms_data[room].update({'temp': data.get('temp', 36.8)})
    elif msg_type == 'set_rhythm':
        rooms_data[room].update({'rhythm': data.get('rhythm', 'nsr')})

    # --- Advanced mode state storage ---
    elif msg_type == 'vitals_adv':
        rooms_data[room]['mode'] = 'advanced'
        rooms_data[room].update({
            'hr': data.get('hr', rooms_data[room]['hr']),
            'spo2': data.get('spo2', rooms_data[room]['spo2']),
            'sys': data.get('sys', rooms_data[room]['sys']),
            'dia': data.get('dia', rooms_data[room]['dia']),
            'rhythm': data.get('rhythm', rooms_data[room]['rhythm'])
        })
    elif msg_type == 'reset':
        rooms_data[room].update({
            'hr': 75, 'spo2': 98, 'sys': 120, 'dia': 80,
            'temp': 36.8, 'rhythm': 'nsr'
        })
    elif msg_type == 'system_reset':
        rooms_data[room] = create_room(rooms_data[room].get('mode', 'basic'))

    # Forward ALL messages to monitors in the room
    emit('update_monitor', data, room=room)

@socketio.on('system_shutdown')
def handle_shutdown(data):
    room = data.get('room')
    if room:
        emit('system_shutdown_trigger', {}, room=room)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=True)
