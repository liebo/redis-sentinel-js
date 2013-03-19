
var redis = require('redis');

module.exports = CommandQueue;

function CommandQueue(client) {
    redis.Multi.call(this);
    var self = this;
    this.queue = [];
    this.client = client;
    this.queue.push = function(command_array) {
        command_array.push( (new Date()).getTime() + self.client.failover_timeout );
        self.queue[self.queue.length] = command_array;
        if (!self.should_clear_commands) {
            self.should_clear_commands = true;
            self.clear_expired_commands();
        }
    };

}

CommandQueue.prototype.__proto__ = redis.Multi.prototype;

CommandQueue.prototype.exec = function() {
    this.should_clear_commands = false;
    if ( this.queue.length ) {
        var args = this.queue.shift();
        args.pop();
        var command = args.shift();
        var cb = args.pop();
        if (command.toLowerCase() === 'hmset' && typeof args[1] === 'object') {
            obj = args.pop();
            Object.keys(obj).forEach(function (key) {
                args.push(key);
                args.push(obj[key]);
            });
        } else args = args[0];
        this.client.send_command(command, args, cb)
        this.exec();
    }
};

CommandQueue.prototype.EXEC = CommandQueue.prototype.exec;

CommandQueue.prototype.clear_expired_commands = function() {
    var self = this;
    setTimeout(function() {self.expire_queue_daemon()}, 500);
};
CommandQueue.prototype.clear_expired_commands_immediately = function() {
    if (!this.should_clear_commands) return;
    var now = (new Date).getTime();
    while ( this.queue.length > 0 && this.queue[0][this.queue[0].length-1] < now ) {
        if (!this.should_clear_commands) return;
        var args = this.queue.shift();
        if (typeof args[args.length-2] == 'function') args[args.length-2]('Call Expired');
    }
    if (!this.queue.length) this.should_clear_commands = false;
    return this.should_clear_commands;
};
CommandQueue.prototype.expire_queue_daemon = function() {
    var self = this;
    if (this.clear_expired_commands_immediately())
        setTimeout(function(){self.expire_queue_daemon}, 500);
};
