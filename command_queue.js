var redis = require('redis');

module.export = CommandQueue;

function CommandQueue(client, timeout) {
    redis.Multi.call(this);
    this.queue = [];
    this.queue.push = function(command_array) {
        command_array.push( (new Date(timeout)).getTime() );
        Array.push.call(this.queue, command_array);
    }
}

CommandQueue.prototype.__proto__ = redis.Multi.prototype;

CommandQueue.prototype.exec = function(callback) {
    this.clear_expired_commands = false;
    this.queue.forEach(function(args) {
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
    }, this);
};
