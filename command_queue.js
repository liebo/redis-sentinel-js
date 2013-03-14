
var redis = require('redis');

module.export = CommandQueue;

function CommandQueue(client) {
    redis.Multi.call(this);
    this.queue = [];
    this.queue.push = function(command_array) {
        command_array.push( (new Date(this.client.failover_timeout)).getTime() );
        Array.push.call(this.queue, command_array);
        if (!this.should_clear_commands) {
            this.should_clear_commands = true;
            this.clear_expired_commands();
        }
    }

    this.clear_expired_commands = function() {
        if (!this.should_clear_commands) return;
        var now = (new Date).getTime();
        while ( this.queue.length > 0 && this.queue[0][-1] < now ) {
            if (!this.should_clear_commands) break;
            var args = this.queue.shift();
            if (typeof args[-2] == 'function') args[-2]('Call Expired');
        }
        if (!this.queue.length) this.should_clear_commands = 0;
        else setTimeout(clear_expired_commands.bind(this), 500);
    }
}

CommandQueue.prototype.__proto__ = redis.Multi.prototype;

CommandQueue.prototype.exec = function(callback) {
    this.should_clear_commands = false;
    while( this.queue.length > 0 ) {
        var args = queue.shift();
        args.pop();
        var command = args[0];
        var cb;
        if (typeof args[-1] == 'function') {
            cb = args[-1];
            args = args.slice(1, -1);
        } else {
            args = args.slice(1);
        }
        if (args.length === 1 && Array.isArray(args[0])) {
            args = args[0];
        }
        if (command.toLowerCase() === 'hmset' && typeof args[1] === 'object') {
            obj = args.pop();
            Object.keys(obj).forEach(function (key) {
                args.push(key);
                args.push(obj[key]);
            });
        }
        this.client.send_command(command, args, cb);
    }
};

CommandQueue.prototype.EXEC = CommandQueue.prototype.exec;
