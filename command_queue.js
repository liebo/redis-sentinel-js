
var redis = require('redis');
var logger = require('./logger.js');

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

    if ( !this.queue.length ) return;
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
};

CommandQueue.prototype.exec_reads = function(index) {
    index = index || 0;
    if (this.queue.length <= index) return;
    if (this.is_write_command(this.queue[index][0]))
        return this.exec_reads(index + 1);

    var args = this.queue.splice(index, 1)[0];
    args.pop();
    var command = args.shift();
    var cb = args.pop();

    args = args[0];
    this.client.send_command(command, args, cb);
    this.exec_reads(index);
}

CommandQueue.prototype.is_write_command = function(command) {
    return /(pop)|(set)|(del)/i.test(command);
}

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
    var num_commands_expired = 0;
    while ( this.queue.length > 0 && this.queue.oldest_timestamp() < now && this.should_clear_commands ) {
        var args = this.queue.shift();
        num_commands_expired++;
        if (typeof args[args.length-2] == 'function') args[args.length-2]( command_expired_error() ); // call callback with an error
    }
    logger.debug('Expired '+num_commands_expired+' for master client: '+this.client.name);
    if (!this.queue.length) this.should_clear_commands = false;
};

function command_expired_error() {
    return new Error('Command expired in failsafe queue')
}
