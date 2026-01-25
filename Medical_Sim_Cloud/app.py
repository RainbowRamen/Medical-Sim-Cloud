import os
from flask import Flask, render_template
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, cors_allowed_origins="*")

rooms_data = {}

@app.route('/')
@app.route('/monitor')
def monitor():
    return render_template('monitor.html')

@app.route('/control')
def controller():
    return render_template('controller.html')

@socketio.on('join')
def on_join(data):
    room = data['room']
    join_room(room)
    if room not in rooms_data:
        rooms_data[room] = {'hr': 60, 'spo2': 98, 'sys': 120, 'dia': 80}
    emit('update_monitor', {'type': 'vitals', **rooms_data[room]}, to=room)

@socketio.on('update_vitals')
def handle_vitals(data):
    room = data.get('room')
    if room and room in rooms_data:
        emit('update_monitor', data, to=room)

if __name__ == '__main__':
    print("Server starting on http://127.0.0.1:5000")
    socketio.run(app, host='127.0.0.1', port=5000, debug=True)