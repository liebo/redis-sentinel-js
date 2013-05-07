
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
    this.queue.oldest_timestamp = function() {
        return this[0][this[0].length-1];
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
        this.client.send_command(command, args, cb);
        this.exec();
    }
};

CommandQueue.prototype.EXEC = CommandQueue.prototype.exec;

/**
 * Starts the interval for clearing expired commands.
 */
CommandQueue.prototype.clear_expired_commands = function() {
    setTimeout(this.expire_queue_daemon.bind(this), 500);
};
/**
 * Expires commands untill this.should_clear_commands is false or the queue is empty.
 */
CommandQueue.prototype.expire_queue_daemon = function() {
    this.clear_expired_commands_immediately();
    if (this.should_clear_commands)
        setTimeout(this.expire_queue_daemon.bind(this), 500);
};
/**
 * Clears all expired commands and clears should_clear_commands flag if the queue is empty.
 */
CommandQueue.prototype.clear_expired_commands_immediately = function() {
    var now = (new Date).getTime();
    while ( this.queue.length > 0 && this.queue.oldest_timestamp() < now && this.should_clear_commands ) {
        var args = this.queue.shift();
        if (typeof args[args.length-2] == 'function') args[args.length-2]( command_expired_error() ); // call callback with an error
    }
    if (!this.queue.length) this.should_clear_commands = false;
};

function command_expired_error() {
    return new Error('Command expired in failsafe queue')
}
