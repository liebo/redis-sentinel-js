require('should');
var CommandQueue = require('../../command_queue.js');
var client_stub = {
    failover_timeout: 700,
    send_command: function(command, args, callback) {
        this.num_commands_executed = this.num_commands_executed || 0;
        this.num_commands_executed++;
    }
};
describe('CommandQueue', function() {
    it('expires old commands by calling the callback with an error', function(done) {
        var cq = new CommandQueue(client_stub);
        cq.ping();
        cq.ping();
        cq.ping();
        cq.queue.length.should.eql(3);
        setTimeout(function() {
            cq.queue.length.should.eql(0);
            done();
        }, 1400);
    });
    it('executes commands when exec is called', function() {
        var cq = new CommandQueue(client_stub);
        cq.ping();
        cq.ping();
        cq.ping();
        cq.exec();
        client_stub.num_commands_executed.should.eql(3);
    });
});
